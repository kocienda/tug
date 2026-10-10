/**
 * DeckManager -- orchestrates card state and the React render pipeline.
 *
 * Operates against the two-table model: `deckState.cards` (content
 * identities) and `deckState.panes` (visual frames). Every public mutator
 * keeps the two tables in sync, preserving the invariants documented in
 * `layout-tree.ts` (no orphan cards, no empty panes, activeCardId ∈ cardIds).
 *
 * DeckManager is a subscribable store conforming to the `useSyncExternalStore`
 * contract. One `root.render()` at construction time; all subsequent state
 * changes call `notify()` instead of render().
 *
 * **Authoritative references:**
 * - [D01] DeckManager is a subscribable store with one root.render() at mount
 * - [D02] Extract IDeckManagerStore interface to break circular imports
 * - [D04] Single-call registration, [D08] DeckManager stays a plain class
 *
 * ## Design notes
 *
 * - `notify()` fires all subscriber callbacks after each state mutation.
 *   `useSyncExternalStore` forces SyncLane updates (always synchronous).
 * - Each state-mutating method assigns `this.deckState = { ...this.deckState }`
 *   (shallow copy) before calling `notify()` so React sees a new reference.
 * - `subscribe`, `getSnapshot`, and `getVersion` are arrow properties for
 *   stable identity and auto-bound `this`.
 * - The constructor calls `this.reactRoot.render()` exactly once, wrapping the
 *   tree with `DeckManagerContext.Provider`.
 * - Stack positions cascade: each new stack offsets (30, 30) from the previous.
 * - Cards whose componentId is not registered in the card registry are
 *   filtered out at load time (see `filterRegisteredCards`).
 */

import type { ControlAction } from "@tugproto/control";
import {
  type DeckState,
  type CardState,
  type TugPaneState,
  type CardStateBag,
  validateDeckState,
  clampPanesToDeck,
  sweptArriving,
} from "./layout-tree";
import { buildDefaultLayout } from "./serialization";
import { LayoutPersistence, loadBootLayout } from "./layout-persistence";
import { CardStateCache, type CardFlushResult } from "./card-state-cache";
import { SpacesStore } from "./spaces-store";
import * as layoutImposition from "./layout-imposition";
import type { ImpositionDeps, SlotAssignment } from "./layout-imposition";
import { ComponentStateRegistries, EngineHookRegistry } from "./engine-hooks";
import * as teardown from "./teardown";
import type { TeardownSaveDeps, TeardownSaveOptions, TeardownSaveResult, TerminationVerdict } from "./teardown";
import { seedDeckState, type SeedDeckStateArgs } from "./deck-manager-test-seed";
import * as fold from "./fold";
import { panesWithWallFolded, type FoldDeps } from "./fold";
import { nextCascadePosition } from "./cascade";
import { composeDeparting, type DepartingEntry } from "./lib/departing";
import { scheduleAfterPaint, type CancelAfterPaint } from "./lib/after-paint";
import { SpaceSwitchMark, switchMarkDeadlineMs } from "./lib/space-switch-mark";
import {
  duplicatedDeck,
  moveCardBetweenDecks,
  nextSpaceName,
  parkedDeck,
  type SpacesSnapshot,
  type SpacesState,
} from "./spaces";
import {
  getAllRegistrations,
  getRegistration,
  getComfortWidth,
  getGreedRank,
  getSizePolicy,
  getStackSizePolicy,
  isSidebarCard,
  takesContentWidth,
} from "./card-registry";
import {
  ARRIVAL_REVEAL_BOUND_MS,
  arrivalRevealDue,
  type ArrivalQuiet,
} from "./lib/arrival-reveal";
import { CARDS_CARD_ID } from "./lib/cards-card-id";
import { ARCS_CARD_ID } from "./lib/arcs-card-id";
import { LAYOUT_CARD_ID } from "./lib/layout-card-id";
import { JOTS_CARD_ID } from "./lib/jots-card-id";
import { OVERVIEW_CARD_ID } from "./lib/overview-card-id";
import {
  clearOpeningBidReport,
  noteOpeningBidMember,
  openingBidReportedFor,
} from "./lib/opening-bid";
import { tugDevLogStore } from "./lib/tug-dev-log-store/tug-dev-log-store";
import {
  bullseyePaneIdOf,
  columnAllocationOf,
  columnMembersOf,
  columnMoveOrder,
  deckColumnsOf,
  deckFlowStrip,
  findSidebarPanes,
  isSidebarParked,
  railMembersToPark,
  workspacePanes,
  paneRenderWidthOf,
  railAllocationOf,
  railMembersOf,
  placeMembers,
  placeRunsMoved,
  type PlaceRuns,
} from "./deck-store-selectors";
import { resolveCloseSuccessor } from "./lib/close-successor";
import { fitHeights, railNaturalOf } from "./lib/rail-fit";
import { sidebarWidthStore } from "./lib/sidebar-width-store";
import {
  clampRailWidth,
  railWidthLimitsOf,
  withRailWidth,
  type RailWidthLimits,
} from "./lib/rail-width";
import { publishFlowOffset } from "./lib/imposer-gauges";
import { TugConnection } from "./connection";
import React from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterGesture, flushSync, gestureScope, tellReactNow } from "@/lib/gesture-scope";

import { DeckCanvas } from "./components/chrome/deck-canvas";
import { ConfigureTug } from "./components/tugways/configure-tug";
import { TugLogout } from "./components/tugways/tug-logout";
import { writeCanvasFlowOffset } from "./components/chrome/flow-offset";
import { ConfigureTugRequest } from "./components/tugways/configure-tug-request";
import { TugVersionGate } from "./components/tugways/tug-version-gate";
import { TugRestoreGate } from "./components/tugways/tug-restore-gate";
import { ErrorBoundary } from "./components/chrome/error-boundary";
import {
  CANVAS_BACKGROUND_ATTRIBUTE_SELECTOR,
  SPACE_SWITCHING_ATTRIBUTE,
} from "./components/chrome/space-layer";
import { TugBannerProvider } from "./components/chrome/tug-banner-bridge";
import { RateLimitBulletinBridge } from "./components/chrome/rate-limit-bulletin-bridge";
import { RateLimitStore } from "./lib/rate-limit-store";
import { UsageStore } from "./lib/usage-store";
import { UsageContext } from "./lib/usage-context";
import { ResponderChainProvider } from "./components/tugways/responder-chain-provider";
import { TugTooltipProvider } from "./components/tugways/tug-tooltip";
import { TugAlertProvider } from "./components/tugways/tug-alert";
import { TugBulletinProvider } from "./components/tugways/tug-bulletin";
import {
  TugThemeProvider,
  applyLoadedTheme,
  applyTheme,
  type ThemeName,
} from "./contexts/theme-provider";
import { composeProviders } from "./lib/compose-providers";
import type {
  EngineHooks,
  IDeckManagerStore,
  MovePaneOptions,
} from "./deck-manager-store";
import {
  allocateSidebarWidths,
  clampSlot,
  slotCount,
  isSidebarPinned,
  isSidebarSeated,
  sidebarSide,
  railHiddenMembers,
  withRailHidden,
  clampFlowOffset,
  clampStripOffset,
  columnModeOf,
  type PlaceAllocation,
  effectiveRailOrder,
  flowRevealOffset,
  flowBandEdges,
  type FlowBandEdges,
  wallRevealOffset,
  impositionGapBottomPx,
  IMPOSITION_GAP_PX,
  RAIL_EDGE_INSET_PX,
  railGapBottomPx,
  RAIL_SEAM_PX,
  stripRevealOffset,
  withRailOrder,
  withSidebarMovedToRail,
  withColumnMode,
  sweptColumnOrders,
  withColumnOrder,
  withColumnShares,
  withRailShares,
  placeSharesFromHeights,
  CONTENT_WIDTH_SLIM_PX,
  DEFAULT_CONTENT_WIDTH,
  DEFAULT_IMPOSITION_KIND,
  withSidebarPinned,
  withSidebarSide,
  resolveContentWidthPx,
  vacancyExtent,
  type ContentWidth,
  type DeckImposition,
  type ImpositionKind,
  type ColumnMode,
  type ImpositionLayout,
  type ResizeSlot,
  type ColumnMoveTarget,
  type RailArrangement,
  type RailPolicy,
  type RailWidths,
  type SidebarEntry,
  type SidebarSide,
} from "./lib/layout-imposer";
import {
  chooseOpeningSlot,
  readOpeningDeck,
  type OpeningChoice,
} from "./lib/opening-placement";
import {
  getTugTiming,
  isTugMotionEnabled,
} from "./components/tugways/scale-timing";
import { DeckManagerContext } from "./deck-manager-context";
import { BASE_THEME_NAME } from "./theme-constants";
import {
  CardLifecycle,
  CardLifecycleContext,
  registerCardLifecycle,
  type CardLifecycleManager,
  type CardLifecycleObserver,
} from "./lib/card-lifecycle";
import {
  AppLifecycle,
  AppLifecycleContext,
  registerAppLifecycle,
} from "./lib/app-lifecycle";
import {
  SheetLifecycle,
  SheetLifecycleContext,
  registerSheetLifecycle,
} from "./lib/sheet-lifecycle";
import {
  BannerLifecycle,
  BannerLifecycleContext,
  registerBannerLifecycle,
} from "./lib/banner-lifecycle";
import { registerDeckStore, getDeckStore } from "./lib/deck-store-registry";
import { isDevEnv } from "./lib/dev-env";
import {
  installLifecycleCascade,
  type LifecycleCascadeHandle,
} from "./lib/lifecycle-cascade";
import type { ComponentStatePreservationRegistry } from "./components/tugways/component-state-preservation-registry";
import {
  CardStateOrchestrator,
  type CardAssembler,
} from "./card-state-orchestrator";
import {
  deckTrace,
  type CommitLanding,
  type SaveCallbackSource,
} from "./deck-trace";
import { cardServicesStore } from "./lib/card-services-store";
import type { CardBinding } from "./protocol";
import { cardSessionBindingStore } from "./lib/card-session-binding-store";
import { spaceBindingsLedgerStore } from "./lib/space-bindings-ledger-store";
import { mark as perfMark } from "@/lib/perf-marks";
import {
  mayDeferCommit,
  reactivateCurrentFocusDestination,
  transferFocusAfterMove,
  transferFocusForActivation,
} from "./focus-transfer";

/**
 * The registered `componentId` of a Session card.
 *
 * Spelled here rather than imported from `lib/session-restore.ts`, which holds
 * the same constant for its own use: that module reaches back into this one
 * through the services store, and a value import would close the loop for the
 * sake of a five-character string.
 */
const SESSION_COMPONENT_ID = "session";

/**
 * Whether a cached bindings-ledger row ([P08]) describes a session worth
 * closing: one the server holds alive, one with a transcript on disk, or one
 * that has taken a turn.
 *
 * The one test, shared by {@link DeckManager.spaceHoldsLiveSessions} and by
 * `deleteSpace`'s close loop. They must not be able to disagree — a confirm
 * that counts three and a close that sends two is [P07]'s whole hazard.
 */
function cachedRowIsLive(row: CardBinding | undefined): row is CardBinding {
  if (row === undefined) return false;
  return row.is_alive === true || row.has_jsonl === true || row.turn_count > 0;
}

export type { SlotAssignment } from "./layout-imposition";
export type { TeardownSaveResult, TerminationVerdict } from "./teardown";
export { columnIsWall, panesWithFolded, panesWithWallFolded } from "./fold";

/**
 * Module-scope guard so the window `focus` / `blur` listeners that
 * drive `DeckState.hasFocus` install exactly once per JS context, even
 * if a test (or a future multi-deck scenario) constructs more than one
 * `DeckManager`. Handlers read the live store via
 * {@link getDeckStore} rather than closing over a specific instance,
 * so they remain correct across deck-store replacement.
 */
let focusListenersInstalled = false;

function installDeckStoreFocusListeners(): void {
  if (focusListenersInstalled) return;
  if (typeof window === "undefined") return;
  focusListenersInstalled = true;
  const onFocus = (): void => {
    const store = getDeckStore();
    if (store === null) return;
    // Order matters: setHasFocus(true) must land before the helper
    // call because the engine's activation-permission query reads
    // state.hasFocus — it would refuse a transfer issued while
    // hasFocus is still false from the prior blur.
    store.setHasFocus(true);
    reactivateCurrentFocusDestination(store);
  };
  const onBlur = (): void => {
    const store = getDeckStore();
    if (store === null) return;
    // Synchronous save-on-blur. Closes the stale-bag residual: a
    // user who cmd-tabs away mid-typing leaves `bag.focus` /
    // `bag.formControls` reflecting the moment of the last
    // debounced save (which may be hundreds of ms stale). Without
    // this flush, the subsequent reactivate on window-focus would
    // restore stale form-control values. visibilitychange covers
    // tab-hide on browsers, but window-blur without tab-hide is
    // the common cmd-tab case on macOS — saving here makes the
    // pre-resign capture unconditional.
    const fr = store.getFirstResponderCardId();
    if (fr !== null) {
      store.invokeSaveCallback(fr, "window-blur");
    }
    store.setHasFocus(false);
  };
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
}

/** How many distinct cards {@link DeckManager}'s activation history keeps. */
const ACTIVATION_HISTORY_LIMIT = 64;

/**
 * Pure helper: remove `cardId` from the stack's `cardIds` and pick a new
 * `activeCardId` if the removed card was active. Mirrors the fallback rule
 * used by `_removeCard`, `_detachCard`, and `_moveCardToPane`: the previous
 * card becomes active, or the first card if the removed card was first.
 *
 * Returns `activeCardId: null` when the stack is left empty — the caller
 * decides what to do (close the stack, or drop it because its card moved
 * elsewhere). Returns the input references unchanged when `cardId` is not
 * in `cardIds`.
 */
function spliceCardFromStack(
  win: TugPaneState,
  cardId: string,
): { cardIds: readonly string[]; activeCardId: string | null } {
  const cardIndex = win.cardIds.indexOf(cardId);
  if (cardIndex === -1) {
    return { cardIds: win.cardIds, activeCardId: win.activeCardId };
  }
  const cardIds = win.cardIds.filter((id) => id !== cardId);
  if (cardIds.length === 0) {
    return { cardIds, activeCardId: null };
  }
  let activeCardId = win.activeCardId;
  if (activeCardId === cardId) {
    activeCardId = cardIds[cardIndex > 0 ? cardIndex - 1 : 0];
  }
  return { cardIds, activeCardId };
}

/**
 * The rails a factory-fresh deck stands, side by side: each side's members top
 * to bottom, the share of the run each one takes, and the width every member
 * of the side stands at.
 *
 * Arcs, Jots and Overview divide the left rail with Overview taking the most
 * of it; Workspaces and Layout divide the right with Workspaces taking the
 * most. Shares are weights, so each side's sum to its member count — the
 * scale a rail divided at equal shares stands at.
 *
 * The width is the side's, not each card's preferred one: a rail stands as
 * wide as its widest pane, so one member at its own preferred width (Overview
 * prefers its 64-character measure) would widen the whole side.
 */
export const FACTORY_RAILS: Readonly<
  Record<
    SidebarSide,
    {
      order: readonly string[];
      shares: Readonly<Record<string, number>>;
      widthPx: number;
    }
  >
> = {
  left: {
    order: [ARCS_CARD_ID, JOTS_CARD_ID, OVERVIEW_CARD_ID],
    shares: { [ARCS_CARD_ID]: 0.47, [JOTS_CARD_ID]: 0.68, [OVERVIEW_CARD_ID]: 1.85 },
    widthPx: 420,
  },
  right: {
    order: [CARDS_CARD_ID, LAYOUT_CARD_ID],
    shares: { [CARDS_CARD_ID]: 1.36, [LAYOUT_CARD_ID]: 0.64 },
    widthPx: 395,
  },
};

/**
 * Every card a factory-fresh deck stands on its rails, frontmost first:
 * Workspaces heads it, so it is the card the deck activates.
 *
 * Read reversed as the order the panes are appended in, which is what settles
 * which one is frontmost; see `DeckManager._createFactoryRail`. The rails'
 * vertical orders are a separate record, written by
 * {@link factoryDeckImposition}.
 */
export const FACTORY_RAIL_ORDER: readonly string[] = [
  ...FACTORY_RAILS.right.order,
  ...FACTORY_RAILS.left.order,
];

/** The N-up rule a factory-fresh deck stands under. */
export const FACTORY_IMPOSITION_KIND: ImpositionKind = "four-up";

/** The width a factory-fresh deck opens its content cards at. */
export const FACTORY_CONTENT_WIDTH: ContentWidth = "slim";

/**
 * The imposition a factory-fresh deck stands under: four-up flow at the slim
 * content width, and every card of {@link FACTORY_RAILS} pinned to its side,
 * in its order, at its share.
 *
 * The orders are written explicitly rather than left absent because absent
 * means *registration* order to {@link effectiveRailOrder}, and `main.tsx`
 * registers jots, overview, arcs, cards, layout — not the order the factory
 * rails ask for. Sides go through {@link withSidebarSide}, which pins as it
 * places.
 *
 * Pure over the imposition — no registry, no DOM — so the deck's plan can be
 * read without a container.
 */
export function factoryDeckImposition(
  imposition: DeckImposition,
): DeckImposition {
  let next: DeckImposition = {
    ...imposition,
    kind: FACTORY_IMPOSITION_KIND,
    contentWidth: FACTORY_CONTENT_WIDTH,
    layout: "flow",
  };
  const rails: NonNullable<DeckImposition["rails"]> = { ...next.rails };
  for (const side of ["left", "right"] as const) {
    const rail = FACTORY_RAILS[side];
    for (const componentId of rail.order) {
      next = withSidebarSide(next, componentId, side);
    }
    rails[side] = { order: [...rail.order], shares: { ...rail.shares } };
  }
  return { ...next, rails };
}

/**
 * Drop every unregistered componentId from an imposition — the imposition half
 * of what {@link filterDeckStateByRegistration} does for cards and panes.
 *
 * Two passes, in this order. First **registration**: an unregistered id leaves
 * `sidebars`, leaves each side's `rails[side].order`, and leaves that side's
 * `rails[side].shares`. Second — and **only for a side that still has a stored
 * `order`** — any surviving `shares` key naming no id in that `order` is
 * dropped, which is what makes the two records agree again.
 *
 * The order of those passes is the whole design. `RailArrangement.order` is
 * documented to outlive the members it names on purpose ([L23]): close a split
 * member and its position is still recorded, so reopening it puts it back where
 * it was. A reconciliation keyed on *standing* would destroy that. Keying on
 * *registration* does not, because an unregistered id can never stand again.
 * And the second pass is guarded on `order` being present because a side
 * carrying `shares` and no `order` has nothing to reconcile against — dropping
 * its weights there would erase a real arrangement.
 *
 * An `order`, a `shares`, a side, or the whole `rails` record left empty is
 * removed rather than kept as `[]` / `{}`, matching `parseRails`, which drops
 * empty fields for the same reason. `mode` and `layout` are never touched:
 * both describe the side, not its membership, and they survive by riding the
 * `{ ...arrangement }` copy below rather than by being named ([L23]).
 *
 * Returns the same reference when there was nothing to sweep.
 */
export function sweepImposition(
  imposition: DeckImposition,
  isRegistered: (componentId: string) => boolean,
): DeckImposition {
  let changed = false;

  const sidebars: Record<string, SidebarEntry> = {};
  for (const [componentId, entry] of Object.entries(imposition.sidebars ?? {})) {
    if (!isRegistered(componentId)) {
      changed = true;
      continue;
    }
    sidebars[componentId] = entry;
  }

  const rails: { left?: RailArrangement; right?: RailArrangement } = {};
  for (const side of ["left", "right"] as const) {
    const arrangement = imposition.rails?.[side];
    if (arrangement === undefined) continue;

    let order = arrangement.order;
    if (order !== undefined) {
      const kept = order.filter((id) => isRegistered(id));
      if (kept.length !== order.length) {
        changed = true;
        order = kept.length > 0 ? kept : undefined;
      }
    }

    let shares = arrangement.shares;
    if (shares !== undefined) {
      const survivors = Object.entries(shares).filter(
        // Pass one on the left of the `&&`, pass two on the right — and the
        // right is inert unless this side still stores an `order`.
        ([id]) => isRegistered(id) && (order === undefined || order.includes(id)),
      );
      if (survivors.length !== Object.keys(shares).length) {
        changed = true;
        shares =
          survivors.length > 0 ? Object.fromEntries(survivors) : undefined;
      }
    }

    const swept: RailArrangement = { ...arrangement };
    if (order === undefined) delete swept.order;
    else swept.order = order;
    if (shares === undefined) delete swept.shares;
    else swept.shares = shares;

    if (Object.keys(swept).length > 0) rails[side] = swept;
    else changed = true;
  }

  if (!changed) return imposition;

  const next: DeckImposition = { ...imposition, sidebars };
  if (Object.keys(rails).length > 0) next.rails = rails;
  else delete next.rails;
  return next;
}

/**
 * Drop cards whose `componentId` is not registered, and any stack left with no
 * surviving cards; rewrite each surviving stack's `cardIds` + `activeCardId`;
 * and sweep the same unregistered ids out of the imposition, which is what
 * keeps the placement record agreeing with the card list rather than
 * contradicting it. See {@link sweepImposition}.
 *
 * Pure over `(state, isRegistered)` — the DeckManager passes `getRegistration`.
 * This is the graceful-degrade path for a retired card: a persisted blob that
 * still names a card no registration answers for drops it with a warn, a stack
 * that held only it drops too — no boot crash — and its `sidebars` entry and
 * its place in `rails.right` go with it. Returns `state` unchanged (same
 * reference) when nothing was dropped and nothing was swept.
 */
export function filterDeckStateByRegistration(
  state: DeckState,
  isRegistered: (componentId: string) => boolean,
): DeckState {
  let changed = false;

  const keptCards: CardState[] = [];
  const droppedCardIds = new Set<string>();
  for (const card of state.cards) {
    if (!card.componentId || !isRegistered(card.componentId)) {
      console.warn(
        `[DeckManager] filterRegisteredCards: dropping card "${card.id}" — ` +
          `unregistered componentId "${card.componentId ?? "(none)"}".`,
      );
      droppedCardIds.add(card.id);
      changed = true;
      continue;
    }
    keptCards.push(card);
  }

  const keptStacks: TugPaneState[] = [];
  for (const win of state.panes) {
    const survivingCardIds = win.cardIds.filter((id) => !droppedCardIds.has(id));
    if (survivingCardIds.length === 0) {
      console.warn(
        `[DeckManager] filterRegisteredCards: dropping stack "${win.id}" — ` +
          `all cards had unregistered componentIds.`,
      );
      changed = true;
      continue;
    }
    let activeCardId = win.activeCardId;
    if (!survivingCardIds.includes(activeCardId)) {
      activeCardId = survivingCardIds[0];
      changed = true;
    }
    if (
      survivingCardIds.length !== win.cardIds.length ||
      activeCardId !== win.activeCardId
    ) {
      keptStacks.push({ ...win, cardIds: survivingCardIds, activeCardId });
    } else {
      keptStacks.push(win);
    }
  }

  // An imposition-only edit still counts: a dead id can outlive every card
  // that named it — the user's `rails.right.order` held a dead id long after the
  // card was gone — and returning `state` there would leave the record
  // uncorrected and unsaved.
  const imposition = sweepImposition(state.imposition, isRegistered);
  if (imposition !== state.imposition) changed = true;

  if (!changed) return state;

  const keptPaneIds = new Set(keptStacks.map((s) => s.id));
  const activePaneId =
    state.activePaneId !== undefined && keptPaneIds.has(state.activePaneId)
      ? state.activePaneId
      : undefined;

  return {
    ...state,
    cards: keptCards,
    panes: keptStacks,
    imposition,
    ...(activePaneId !== undefined
      ? { activePaneId }
      : { activePaneId: undefined }),
  };
}

/**
 * The reservations record a sheet's report writes: `memberId`'s entry set to
 * `height`, or REMOVED when the height is `null` and the sheet has gone.
 *
 * `undefined` — never `{}` — when the last entry goes, because absence is the
 * one reading of "nobody is claiming" ([B03]'s field contract). An empty
 * record standing where the field used to be absent would be a second spelling
 * of the resting state, and the two would then have to agree forever.
 *
 * Returned by IDENTITY when nothing changes, which is what lets
 * {@link DeckManager.setSheetReservation} short-circuit: a sheet re-reports the
 * height it already reported on every resize of its own panel, and each of
 * those would otherwise be a commit that arms a settle over frames already
 * where they belong.
 *
 * Pure and exported for the same reason {@link panesWithFolded} is: it is the
 * whole of what the commit decides, and it is testable without a DeckManager.
 */
export function sheetReservationsWith(
  standing: Readonly<Record<string, number>> | undefined,
  memberId: string,
  height: number | null,
): Readonly<Record<string, number>> | undefined {
  if (height === null) {
    if (standing === undefined || !(memberId in standing)) return standing;
    const { [memberId]: _dropped, ...rest } = standing;
    return Object.keys(rest).length === 0 ? undefined : rest;
  }
  if (standing?.[memberId] === height) return standing;
  return { ...standing, [memberId]: height };
}

/**
 * The PAIR of records a sheet's claim writes: `memberId`'s reservation set or
 * dropped, and the opening bids with that member's bid cleared when the claim
 * supersedes it ([B02]).
 *
 * The two move together because a measurement SUPERSEDES a bid, and they have
 * to move in one commit: a bid cleared a commit after the claim that replaced
 * it would be a second settle over the same fact, which is the judder the bid
 * exists to prevent.
 *
 * **What supersedes is a claim AT LEAST AS HIGH as the bid, and the sheet
 * going.** A bid's whole job is to be a floor for the arrival window, and the
 * failure it exists to prevent is a bid too SMALL — which a larger measurement
 * corrects by winning the same `Math.max` ([B01]) whether the bid is cleared
 * or not, so clearing it there costs nothing and keeps the record honest. A
 * claim BELOW the standing bid corrects nothing: dropping the bid for it would
 * shrink a member under a sheet that is still standing on it, for a
 * measurement that already fits. So a bid too generous stands until its sheet
 * goes, which is when the condition it was declared for is over, and the
 * `null` claim is what takes it down. Air under a picker on a project with
 * few sessions is the price the declaration already names for itself.
 *
 * That is one answer to "what ends a bid" on every path, and no card-state
 * transition is one of them: the binding commit used to drop the bid and does
 * not any more, because binding is what makes the sheet go and the sheet going
 * is what is read here ([F07]).
 *
 * Each half is returned by IDENTITY when it does not change, which is what
 * lets {@link DeckManager.setSheetReservation} short-circuit on both at once:
 * a sheet re-reports the height it already reported on every resize of its own
 * panel, and by then the bid has either been cleared or been left standing
 * once already.
 *
 * Pure and exported for {@link sheetReservationsWith}'s reason: it is the
 * whole of what the commit decides, and it is testable without a DeckManager
 * while the verb around it is not.
 */
export function sheetClaimWith(
  standing: {
    sheetReservations: Readonly<Record<string, number>> | undefined;
    openingBids: Readonly<Record<string, number>> | undefined;
  },
  memberId: string,
  height: number | null,
): {
  sheetReservations: Readonly<Record<string, number>> | undefined;
  openingBids: Readonly<Record<string, number>> | undefined;
} {
  const bid = standing.openingBids?.[memberId];
  const supersedes = bid === undefined || height === null || height >= bid;
  return {
    sheetReservations: sheetReservationsWith(
      standing.sheetReservations,
      memberId,
      height,
    ),
    openingBids: supersedes
      ? openingBidsWith(standing.openingBids, memberId, null)
      : standing.openingBids,
  };
}

/**
 * {@link sheetReservationsWith}'s twin over {@link DeckState.openingBids}
 * — the same contract, term for term, over the other record.
 *
 * Returned by IDENTITY when nothing changes, which is what lets
 * {@link DeckManager.setOpeningBid} short-circuit, and the field goes
 * away entirely with its last entry so absence stays the one reading of "no
 * bid".
 *
 * A second function rather than a parameterised one: the two records differ in
 * what they MEAN, and a shared helper keyed by which field to touch would be a
 * place for the two meanings to be confused. What they share is arithmetic over
 * a sparse record, which is small enough to say twice.
 */
export function openingBidsWith(
  standing: Readonly<Record<string, number>> | undefined,
  memberId: string,
  height: number | null,
): Readonly<Record<string, number>> | undefined {
  if (height === null) {
    if (standing === undefined || !(memberId in standing)) return standing;
    const { [memberId]: _dropped, ...rest } = standing;
    return Object.keys(rest).length === 0 ? undefined : rest;
  }
  if (standing?.[memberId] === height) return standing;
  return { ...standing, [memberId]: height };
}

/**
 * {@link openingBidsWith}'s twin over {@link DeckState.arriving} — the same
 * contract over the third record: identity when nothing changes, and the
 * field gone with its last entry so absence stays the one reading of
 * "nothing arriving".
 *
 * A third function rather than a parameterised one, for the reason the second
 * was: the records differ in what they MEAN, and what they share is arithmetic
 * over a sparse record, small enough to say three times.
 */
export function arrivingWith(
  standing: Readonly<Record<string, true>> | undefined,
  paneId: string,
  mark: boolean,
): Readonly<Record<string, true>> | undefined {
  if (!mark) {
    if (standing === undefined || !(paneId in standing)) return standing;
    const { [paneId]: _dropped, ...rest } = standing;
    return Object.keys(rest).length === 0 ? undefined : rest;
  }
  if (standing?.[paneId] === true) return standing;
  return { ...standing, [paneId]: true };
}

/**
 * Read the DEBUG-only `__tugRestoreInTestMode` flag. When `true` AND
 * `__tugTestMode` is also `true`, the constructor honors the
 * tugbank-sourced boot arguments (layout, card-state bags, focused
 * card id) instead of starting empty — the production cold-boot
 * restore channel for quit-and-relaunch harness tests. See
 * `tugapp/Sources/TestHarness/TestHarnessUserScript.swift`.
 */
function shouldRestoreInTestMode(): boolean {
  return typeof window !== "undefined" && window.__tugRestoreInTestMode === true;
}

export class DeckManager implements IDeckManagerStore {
  private container: HTMLElement;

  /**
   * The container's client size, read once and kept until it can have moved.
   *
   * The run and band measurements ({@link _placeRunHeight},
   * {@link _flowBandEdges}) read nothing but the canvas container, whose size
   * moves with the window and nothing the deck commits. Read live, each one
   * forced a layout of whatever the commit had just written, and the
   * arrangement effect reads one, writes the arrangement variables, and reads
   * the other: on a 23,000-element deck a rail show paid three layouts in one
   * task (78, 99 and 29 ms), two of them of an arrangement about to be
   * replaced. Kept here, those reads cost nothing, and the settle's own Last
   * pass — which has to measure the new geometry anyway — pays the one
   * layout there is.
   *
   * Dropped on the two edges that can move it: the window's `resize`, which
   * fires before anything in that frame reads, and the container's own
   * `ResizeObserver`, which catches host chrome resizing the canvas without
   * one. The container sits outside every held interior, so the motion gate
   * never holds that delivery (`lib/gesture-scope.ts`).
   */
  private containerSize: { width: number; height: number } | null = null;
  private readonly containerSizeObserver: ResizeObserver | null;
  private readonly dropContainerSize = (): void => {
    this.containerSize = null;
  };
  private connection: TugConnection;

  /**
   * App-level, account-global subscription-quota store ([#step-3.5]). Feeds
   * the single deck-wide `RateLimitBulletinBridge`. Constructed once with the
   * connection; the harness reaches it via {@link getRateLimitStore} to drive
   * the banner without a live claude round-trip.
   */
  private readonly rateLimitStore: RateLimitStore;

  /**
   * App-level, account-global usage-panel store. Serves every card's `/usage`
   * sheet (one `claude -p "/usage"` for the machine); reached through
   * {@link UsageContext}. The harness drives it via {@link getUsageStore}.
   */
  private readonly usageStore: UsageStore;

  /** Current canvas state (two-table shape). */
  private deckState: DeckState;

  /**
   * The layout save timer and the guarded tugbank writers. Constructed in the
   * constructor, once `testMode` is known; it reads the spaces through
   * {@link spacesState} at save time and holds none of its own.
   */
  private readonly persistence: LayoutPersistence;

  // ---- Per-card state cache ([D01], [D06]) ----

  /**
   * Every card's state bag, the dirty set and its debounced flush, the save
   * gate a batch load holds, and the close-time save callbacks. Constructed
   * in the constructor beside {@link persistence}, whose guarded writer it
   * flushes through.
   */
  private readonly cardStates: CardStateCache;

  // ---- Card-state capture ([A9c]) ----

  /**
   * Per-card Component State Preservation Protocol registries ([D13],
   * [A9]). Lazily created on first
   * `getComponentStatePreservationRegistry(cardId)` call from a child
   * component's `useComponentStatePreservation` hook; cleared when the
   * card is destroyed (`_removeCard` / `_closePane`). A card that uses
   * no opt-in components never gets an entry here.
   */
  private readonly componentStateRegistries = new ComponentStateRegistries();

  /**
   * Framework orchestrator for capture ([A9c]). Every save trigger
   * (debounced callback, close-before-destroy flush, `saveState` RPC)
   * routes through `captureCardState`. `CardHost` registers its
   * per-card assembler with this orchestrator on mount. Restore is not
   * the orchestrator's responsibility; consumers mount in their saved
   * state via `useSavedComponentState` / `useSavedRegionScroll` (see
   * `tuglaws/state-preservation.md` → "Restoring saved state at mount").
   */
  private readonly cardStateOrchestrator: CardStateOrchestrator =
    new CardStateOrchestrator((cardId) =>
      this.componentStateRegistries.peek(cardId),
    );

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) {
      if (this.stateFlushed) return;
      void this.teardownSave("visibilitychange");
    }
  };

  private reloadPending = false;

  private stateFlushed = false;

  private readonly handleBeforeUnload = (): void => {
    // Delegate to `captureAllForTeardown`. The body is shared with
    // other teardown-class signals (HMR `vite:beforeUpdate`, etc.)
    // so the iterate-and-save pass has one implementation; the
    // `reason` parameter distinguishes them in the deck-trace ring.
    this.captureAllForTeardown("beforeunload");
  };

  // ---- Initial focused card ID for reload restoration ([D03]) ----

  public initialFocusedCardId: string | undefined;

  /** Single React root for the canvas */
  private reactRoot: Root | null = null;

  /** Set by {@link destroy}: a card landing after it has nothing to land on. */
  private destroyed = false;

  /**
   * The reveal watch standing over each pane that arrived hidden, keyed by
   * pane id — its disposer, and the `decide` the sources call ([B03]).
   * One entry per mark in {@link DeckState.arriving}; an entry outlives its
   * mark only until the next source fires or the bound expires, at which
   * point `decide` finds the mark gone and disposes.
   */
  private readonly arrivalWatches = new Map<
    string,
    { decide: () => void; dispose: () => void }
  >();

  /**
   * The two place runs the last committed imposition was allocated against —
   * `null` on each until the first retune measures it.
   *
   * [P11]'s whole state. A place's standing and its shared heights are both
   * functions of the run now, and non-proportional ones, so a window resize
   * that changes only the height changes the answer while nothing else in the
   * deck moves. This is what {@link retuneSidebarAllocation} compares against
   * to notice.
   */
  private _lastPlaceRuns: PlaceRuns = { rail: null, column: null };

  /**
   * Every card the first responder has landed on, most recent first, each id
   * once. {@link _flipFirstResponder} writes it, because every activation
   * passes through there; a close reads it, so the card it hands the reader
   * is the one they were last working in rather than whichever stands
   * nearest. Ids of closed cards are not pruned here — the reader filters to
   * what still stands — and the list is capped so it cannot grow without
   * bound over a long session.
   */
  private _activationHistory: string[] = [];

  private initialLayout: object | null;

  // ---- Spaces: the level above the deck ([P03]) ----

  /**
   * The spaces list, the active space, the mounted set, and the spaces
   * `useSyncExternalStore` contract ([L02]). The active space's record holds
   * `deck: null`; its live deck is {@link deckState}, handed to the store's
   * readers rather than copied into it.
   */
  private readonly spacesStore = new SpacesStore();

  /** When the last {@link activateSpace} began — see the store interface. */
  private spaceSwitchStartedAt: number | null = null;

  public getSpaceSwitchStartedAt = (): number | null => this.spaceSwitchStartedAt;

  /** When the last committing {@link setPaneFolded} began — see the store
   *  interface. */
  private impositionGestureAt: number | null = null;

  public getImpositionGestureAt = (): number | null => this.impositionGestureAt;

  private initialTheme: ThemeName;

  /**
   * The global theme key's value at boot: what a loaded space that names no
   * theme takes. Absent when the host gave none, and such a space then stays
   * without one.
   */
  private fallbackTheme: ThemeName | undefined;

  // ---- Subscribable store state (useSyncExternalStore contract) ----

  private subscribers: Set<(landing: CommitLanding) => void> = new Set();

  /** Subscribers told inside the commit's own task ([B04], [D204]). */
  private syncSubscribers: Map<(landing: CommitLanding) => void, string> = new Map();

  /** The one deferred notification in flight, coalescing every commit until it flushes. */
  private deferredNotify: { landing: CommitLanding; cancel: CancelAfterPaint } | null = null;
  /**
   * A notify held behind a settle's motion gate ([B05] of set-up-and-go),
   * queued once into the gate's release; later commits under the same gate
   * only widen its landing.
   */
  private gatedNotify: { landing: CommitLanding } | null = null;

  /**
   * The switch epoch's mark, with the deadline this writer owes behind it —
   * see `lib/space-switch-mark.ts` ([L32]).
   */
  private readonly switchMark = new SpaceSwitchMark(SPACE_SWITCHING_ATTRIBUTE, {
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  });

  /**
   * The in-flight commit's deferral vote, live only for the length of the
   * sync-subscriber pass in {@link notify}.
   *
   * A sync subscriber runs BEFORE the commit it is being told about has
   * scheduled its deferral, so `flushPendingNotify` called from inside one
   * has nothing to flush — the notification it wants is still a few lines
   * away. It votes here instead, and `notify` reads the vote where it would
   * otherwise have deferred. Nested so a sync subscriber that provokes its
   * own commit cannot spend the outer commit's vote.
   */
  private inFlightDeferralVote: { flush: boolean } | null = null;

  private stateVersion: number = 0;

  /**
   * The panes that have closed and are still being carried out, keyed by
   * pane id in marking order ([P01], [P02]). {@link deckState} — the deck
   * every mutation reads and writes — never holds one, so no writer can
   * count, re-slot or move a departing pane; {@link getPicture} composes
   * them back in for the readers that draw the deck. Session state only: saving reads
   * `deckState`, and a workspace switch reaps the record first.
   */
  private departingRecord = new Map<string, DepartingEntry>();

  /** Bumped on every change to {@link departingRecord}; half of the picture's memo key. */
  private departingVersion = 0;

  /** How many departure hosts are registered ({@link registerDepartureHost}). */
  private departureHostCount = 0;

  /** The picture ({@link getPicture}), memoized on (`deckState` identity, `departingVersion`). */
  private composedMemo: { deck: DeckState; version: number; composed: DeckState } | null =
    null;

  // ---- Stable bound callbacks ----

  public handlePaneMoved: (
    paneId: string,
    position: { x: number; y: number },
    size: { width: number; height: number },
    opts?: MovePaneOptions,
  ) => void;

  public handlePaneClosed: (paneId: string) => void;

  public readonly cardLifecycle: CardLifecycle;

  public readonly appLifecycle: AppLifecycle;

  public readonly sheetLifecycle: SheetLifecycle;

  public readonly bannerLifecycle: BannerLifecycle;

  private readonly lifecycleCascade: LifecycleCascadeHandle;

  public addCardToPane: (
    paneId: string,
    componentId: string,
    initialContent?: unknown,
  ) => string | null;

  public removeCard: (paneId: string, cardId: string) => void;

  public setActiveCardInPane: (paneId: string, cardId: string) => void;

  public reorderCardInPane: (paneId: string, fromIndex: number, toIndex: number) => void;

  public detachCard: (paneId: string, cardId: string, position: { x: number; y: number }) => string | null;

  public moveCardToPane: (sourcePaneId: string, cardId: string, targetPaneId: string, insertAtIndex: number) => void;

  public setPaneWidth: (paneId: string, preset: ContentWidth) => void;

  // ---- useSyncExternalStore arrow properties (stable identity, auto-bound this) ----

  public subscribe = (callback: (landing: CommitLanding) => void): (() => void) => {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  };

  /**
   * The published deck: the standing {@link deckState}, which never holds a
   * departing pane. Every reader is right by default — one that lists or
   * counts sees past a pane on its way out without having to ask — and the
   * few that draw the departure read {@link getPicture}.
   */
  public getSnapshot = (): DeckState => this.deckState;

  /**
   * The composed picture: the standing deck with every departing pane
   * composed back in at its old position ([P02]). The standing deck itself
   * when nothing departs, and the same object across calls until either half
   * changes, so `useSyncExternalStore` sees no churn.
   */
  public getPicture = (): DeckState => {
    if (this.departingRecord.size === 0) return this.deckState;
    const memo = this.composedMemo;
    if (memo !== null && memo.deck === this.deckState && memo.version === this.departingVersion) {
      return memo.composed;
    }
    const composed = composeDeparting(this.deckState, [...this.departingRecord.values()]);
    this.composedMemo = { deck: this.deckState, version: this.departingVersion, composed };
    return composed;
  };

  public registerDepartureHost = (): (() => void) => {
    this.departureHostCount += 1;
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.departureHostCount -= 1;
      // Nobody is left to carry a departure out, so none may stand.
      if (this.departureHostCount === 0) this.landDepartures();
    };
  };

  public landDepartures = (paneIds?: readonly string[]): void => {
    const ids = paneIds ?? [...this.departingRecord.keys()];
    if (this._destroyDepartures(ids) === 0) return;
    this.notify("landDepartures", "cut");
  };

  /**
   * Every departure, destroyed with no notify — for a caller that is about to
   * commit a whole new deck anyway (a workspace switch, a seed), where a
   * departing pane composed into it would belong to the deck that left.
   */
  private _reapDepartures(): void {
    this._destroyDepartures([...this.departingRecord.keys()]);
  }

  /**
   * The destruction a close with a departure host deferred ([P03]), run for
   * each named entry still in the record, in `_closePane`'s order: every
   * card's save callback flushed, then `cardWillBeginDestruction` for each,
   * then the entry dropped, then the preservation registries discarded.
   * Returns how many entries it removed, having bumped the record's version
   * if that is any.
   */
  private _destroyDepartures(paneIds: readonly string[]): number {
    let removed = 0;
    for (const paneId of paneIds) {
      const entry = this.departingRecord.get(paneId);
      if (entry === undefined) continue;
      for (const cid of entry.pane.cardIds) this.flushSaveCallbackBeforeDestruction(cid);
      for (const cid of entry.pane.cardIds) this.cardLifecycle.notifyCardWillBeginDestruction(cid);
      this.departingRecord.delete(paneId);
      for (const cid of entry.pane.cardIds) this.discardComponentStatePreservationRegistry(cid);
      removed += 1;
    }
    if (removed > 0) this.departingVersion += 1;
    return removed;
  }

  /**
   * {@link subscribe}'s synchronous door ([D204], [B04]).
   *
   * For a DOM writer and for a reader of the flip's edge. Anything on it that
   * reaches REACT does so through the same door React is told through, or the
   * deferral it was given is undone by the subscriber standing next to it.
   */
  public subscribeSync = (callback: (landing: CommitLanding) => void, label = "anon"): (() => void) => {
    this.syncSubscribers.set(callback, label);
    return () => {
      this.syncSubscribers.delete(callback);
    };
  };

  /** {@link IDeckManagerStore.flushPendingNotify}. */
  public flushPendingNotify = (): void => {
    // The vote first, and unconditionally, because the two halves answer
    // different questions. A caller inside the sync-subscriber pass is asking
    // that THIS commit not be deferred — the canvas's `arm` on a retarget
    // ([B01]) — and whether some EARLIER commit's deferral is still in flight
    // has nothing to do with it. Voting only when there is nothing pending
    // left one reachable hole: a commit that armed nothing (a cut, an
    // unchanged signature) defers while an earlier settle's tweens still run,
    // and the next commit's retarget then flushes that stale notification,
    // returns, and is itself deferred — the double-hop, on the path written
    // to close it.
    if (this.inFlightDeferralVote !== null) this.inFlightDeferralVote.flush = true;
    const pending = this.deferredNotify;
    if (pending !== null) {
      this.deferredNotify = null;
      pending.cancel();
      perfMark("tug:react-notify");
      tellReactNow(() => this.subscribers.forEach((cb) => cb(pending.landing)));
      perfMark("tug:react-notify-end");
    }
  };

  /**
   * Tell the subscribers when the motion gate opens. One queued tell per
   * gate: a later commit under it only widens the landing it carries.
   */
  private _scheduleGatedNotify(landing: CommitLanding): void {
    if (this.gatedNotify !== null) {
      if (landing === "cross") this.gatedNotify.landing = "cross";
      return;
    }
    const pending = { landing };
    this.gatedNotify = pending;
    afterGesture(() => {
      if (this.gatedNotify === pending) this.gatedNotify = null;
      perfMark("tug:react-notify");
      this.subscribers.forEach((cb) => cb(pending.landing));
      perfMark("tug:react-notify-end");
    });
  }

  /**
   * Tell the deferred subscribers after the next painted frame ([D204]). rAF
   * runs before that frame's rendering update and a zero timer queued inside
   * it runs after, so the flush lands on the far side of one paint. A deadline
   * timer stands behind it for a window whose rAF is suspended ([L32]).
   */
  private _scheduleDeferredNotify(landing: CommitLanding): void {
    if (this.deferredNotify !== null) {
      if (landing === "cross") this.deferredNotify.landing = "cross";
      return;
    }
    const pending: { landing: CommitLanding; cancel: CancelAfterPaint } = {
      landing,
      cancel: () => {},
    };
    this.deferredNotify = pending;
    pending.cancel = scheduleAfterPaint(() => {
      this.deferredNotify = null;
      perfMark("tug:react-notify");
      tellReactNow(() => this.subscribers.forEach((cb) => cb(pending.landing)));
      perfMark("tug:react-notify-end");
    });
  }

  // ---- Spaces store (a second useSyncExternalStore contract, [P03], [L02]) ----

  /** See `SpacesStore.subscribe`. Stable identity: an arrow property, made once. */
  public subscribeSpaces = (callback: () => void): (() => void) =>
    this.spacesStore.subscribe(callback);

  /** See `SpacesStore.getSnapshot`. Stable until the list changes ([L02]). */
  public getSpacesSnapshot = (): SpacesSnapshot => this.spacesStore.getSnapshot();

  /**
   * Which space holds `cardId` — the active one or a parked one — or `null`
   * when no space does.
   *
   * Over the active space's picture, so a departing card still answers to
   * the workspace it is leaving for the length of its fade: its own content
   * reads who it is this way.
   */
  public spaceOf = (cardId: string): string | null =>
    this.spacesStore.spaceOf(cardId, this.getPicture());

  /**
   * The deck of any space, active or parked. The active space answers with the
   * live {@link deckState}, so no caller has to know which one it asked about.
   */
  public getSpaceDeck = (spaceId: string): DeckState | null =>
    this.spacesStore.deckOf(spaceId, this.getSnapshot());

  /**
   * Every card id this instance holds, across every space.
   *
   * The orphan sweep's input ([P03], Table T01): a sweep given only the active
   * deck's ids would read every parked space's cards as orphaned and delete
   * their state bags, so a workspace the user had not opened this run would
   * come back empty.
   */
  public allSpaceCardIds = (): Set<string> =>
    this.spacesStore.allCardIds(this.getSnapshot());

  /**
   * Called after a space's deck is on screen, with that deck, so the session
   * cards it just mounted can be restored. Set by `main.tsx` (Step 4); `null`
   * until then and in any host that does not restore sessions.
   */
  private spaceRestoreHook: ((deck: DeckState) => void) | null = null;

  /** Install the lazy per-space session restore ([P08]). */
  public setSpaceRestoreHook = (hook: (deck: DeckState) => void): void => {
    this.spaceRestoreHook = hook;
  };


  /**
   * Render `spaceId`'s deck, parking the one on screen ([P04]).
   *
   * **A switch is not a close, and it is not a teardown either.** The one
   * subscriber that turns "card left the deck" into a wire
   * `close_session` is `cardServicesStore`, and it listens to
   * `observeCardWillBeginDestruction` rather than to the deck snapshot. So
   * nothing here fires destruction, nothing calls
   * `flushSaveCallbackBeforeDestruction` or
   * `discardComponentStatePreservationRegistry`, and nothing routes through
   * `_closePane`: every session in the outgoing workspace stays alive, its
   * binding stays in `cardSessionBindingStore`, and its tugcode process is
   * never signalled ([B05], Risk R01).
   *
   * And the outgoing cards get NO capture, because their panes do not
   * unmount. A workspace the user has visited stays mounted and the canvas
   * hides it ([B06]); the bags every other capture moment exists to write
   * are the live DOM itself here, held by cards that were never taken down.
   * So there is nothing to save and nothing to replay, and this method runs
   * neither.
   *
   * **[L26] is on point and is now simply obeyed.** The law says not to tear
   * down an entity that is logically continuous, and a workspace's cards are
   * exactly that. This used to answer the law rather than obey it — the
   * argument was that holding every workspace's panes mounted is a cost the
   * design rejects, so the teardown was genuinely unavoidable and [L23]'s
   * capture-and-replay was the discipline that made it survivable. The
   * measurement behind [B06] refuted the premise: the teardown and the
   * rebuild WERE the switch's cost, and paying it for a workspace that is
   * only being looked away from buys nothing. What stays behind is this
   * record-writing, which persistence and the Workspaces card read.
   */
  public activateSpace = (spaceId: string): void => {
    // (1) Already there.
    if (spaceId === this.spacesStore.activeSpaceId) return;
    const incoming = this.spacesStore.find(spaceId);
    if (incoming === undefined || incoming.deck === null) {
      console.warn(`activateSpace: no parked space with id "${spaceId}"`);
      return;
    }
    const outgoing = this.spacesStore.active();
    if (outgoing === undefined) {
      console.warn(`activateSpace: no active space to leave`);
      return;
    }
    // A departing pane belongs to the deck being left; composed into the
    // incoming one it would stand in a workspace it was never part of.
    this._reapDepartures();
    const incomingDeck = incoming.deck;

    // The switch instrument ([P09]). Every reading below is a delta from
    // `t0`, so the phases are separable and `totalMs` is the whole
    // synchronous span; `paintMs` is stamped in the double rAF at the end,
    // which is the only place the record can be made.
    const t0 = performance.now();
    this.spaceSwitchStartedAt = t0;
    const fromSpaceId = outgoing.id;
    const outgoingCards = this.deckState.cards.length;
    const incomingCards = incomingDeck.cards.length;

    // (2) A card mid-arrival is settled where it stands. Its pane is not
    // unmounted any more, but it is about to have no box to travel in, and a
    // beat that cannot finish is a watch nothing will ever release.
    // `parkedDeck` drops the mark from the record for the same reason.
    for (const watch of Array.from(this.arrivalWatches.values())) {
      watch.dispose();
    }

    // (3) Remember where the user was, and write the outgoing workspace's
    // record.
    //
    // The record is NOT a capture: nothing here is being taken down, and the
    // cards go on holding their own state in their own live DOM ([B06]). It
    // is written because persistence serializes from it and the Workspaces
    // card's read-only rows are drawn from it, and it is `parkedDeck`'s
    // stripped copy for the same reason `serialize` omits those fields — a
    // bullseye posture, a strip offset, a sheet's floor claim, an arrival
    // mark are all facts about what is on screen, and a record is not on
    // screen. Stripping a copy costs the live deck nothing: `parkedDeck`
    // returns a new object and `this.deckState` is untouched, so every
    // transient mark the shown tree still needs is still on it.
    outgoing.focusedCardId = this.getFirstResponderCardId() ?? undefined;
    outgoing.deck = parkedDeck(this.deckState);

    // (4) Deactivate the outgoing first responder and swap the deck in one
    // commit, so subscribers see a single transition rather than a deck
    // whose active pane names a card that is no longer in it.
    const commitStart = performance.now();
    this._flipFirstResponder(
      null,
      () => {
        this.deckState = { ...incomingDeck, hasFocus: this.deckState.hasFocus };
        // Solved against THIS canvas before anybody can see it ([P04]). The
        // deck being swapped in was last solved at the switch away, and the
        // window may have been resized since; this writes `deckState` again
        // with no notify of its own, so the single `notify` below carries the
        // arrangement already correct and `arm` still finds nothing to move.
        this._resolveShownArrangement();
        incoming.deck = null;
        // This workspace is mounted from here on ([P01]). Inside the commit
        // so the invalidation below carries it, and before it so the one
        // snapshot subscribers see already names the new arrangement.
        this.spacesStore.activate(spaceId);
        // The theme changes in this commit, with the cut ([L06]: a stylesheet
        // flip, no React state in the way). Every workspace's theme is
        // loaded ahead of use, so the flip is synchronous and the first frame
        // that shows the arriving cards shows them in their own theme.
        //
        // Dev builds are the exception and it is accepted: the dev server
        // serves the active theme as one HMR'd module that cannot flip
        // synchronously, so `applyLoadedTheme` declines and the theme follows
        // a few frames behind the cut. The same fallback covers a production
        // switch that outran the load of the incoming theme's stylesheet.
        //
        // Asked even when the incoming theme is already on screen: the ask
        // supersedes an apply still in flight from the workspace being left,
        // which would otherwise land after this cut, in the wrong workspace.
        const incomingTheme = incoming.theme;
        if (incomingTheme !== undefined && !applyLoadedTheme(incomingTheme)) {
          void applyTheme(incomingTheme);
        }
        // The switch epoch opens here ([P01], Spec S02). Written before the
        // notify below, so the very first thing any subscriber can do is read
        // it, and written by this method rather than by a layout effect in the
        // canvas: React runs layout effects CHILD-FIRST, so a mark set in
        // `DeckCanvas`'s own effect would already be too late for every re-arm
        // inside the arriving layer — the composer's line box, the pane bar's
        // controls width, the accessory height, the sheet clamps. Every one of
        // those effects has run by the time the canvas's does.
        //
        // `this.container` is the React mount root (`#deck-container`), NOT
        // the element carrying `CANVAS_BACKGROUND_ATTRIBUTE` — that one is a
        // descendant, rendered by `DeckCanvas` and held as its `containerRef`.
        // `paneCanvasOf` cannot answer here because it walks UP from a frame,
        // so the canvas is found by looking down. It is the first such element
        // in document order; the margin caps carry the marker too and are its
        // children. `arm` and the crossfade effect both read and sweep that
        // same element, so the three agree by construction.
        //
        // The mark is a debt from this frame ([L32]). `DeckCanvas` pays it back
        // in the ordinary close, and this writer arms a deadline of its own
        // behind that close, because the canvas's effect only runs when React
        // sees the active id change — two switches in one task that end where
        // they began would otherwise strand it. A host with no canvas in the
        // DOM yet — a boot before the first render, a harness with no deck
        // mounted — simply gets no mark, which is the honest answer: there is
        // nothing on screen to animate.
        //
        this.switchMark.open(
          this.container.querySelector<HTMLElement>(
            CANVAS_BACKGROUND_ATTRIBUTE_SELECTOR,
          ),
          switchMarkDeadlineMs(getTugTiming()),
        );
        // `"cut"`, and that word is the whole of the fix ([P11], [B08]).
        //
        // A switch used to be spelled to the canvas as an ordinary
        // arrangement change, which is a mass departure and a mass arrival:
        // the settle minted a departure ghost for every pane of the workspace
        // being left and held every incoming frame at `opacity: 0` for its
        // arrive beat — so a reader crossing between two workspaces watched
        // the canvas blank and rebuild itself. But the panes do not move
        // across a switch. Both sets of frames are already drawn exactly
        // where this commit puts them, and `"cut"` is the canvas's own word
        // for that: `arm` takes the new arrangement as its baseline, records
        // `outcome: "declined"`, and launches no settle at all.
        //
        // `deleteSpace` reaches here through `activateSpace(neighbour.id)`
        // and inherits the `"cut"` correctly, for the same reason — the
        // neighbour's frames are likewise already where the swap puts them.
        this.notify("activateSpace", "cut");
        this.scheduleSave();
      },
      "activateSpace",
    );
    const commitMs = performance.now() - commitStart;

    // (5) Construction for every incoming card the lifecycle has not seen —
    // the same fan-out the constructor runs over a boot deck, so a card
    // arriving from a parked workspace is announced exactly once, whichever
    // activation first stands it up.
    for (const card of this.deckState.cards) {
      if (!this.cardLifecycle.hasConstructed(card.id)) {
        this.cardLifecycle.notifyCardDidFinishConstruction(card.id);
      }
    }

    // (6) Restore this workspace's sessions, synchronously, BEFORE React
    // mounts its cards — a session card that mounts unbound with no
    // expectation registered falls through to the project picker (Risk R02).
    const restoreStart = performance.now();
    this.spaceRestoreHook?.(this.deckState);
    const restoreMs = performance.now() - restoreStart;

    // (7) Put focus where the user left it in this workspace, falling back to
    // the active pane's card. A space that names a card no longer in its deck
    // gets the fallback rather than nothing.
    const remembered = incoming.focusedCardId;
    const focus =
      remembered !== undefined &&
      this.deckState.cards.some((c) => c.id === remembered)
        ? remembered
        : this.getFirstResponderCardId();
    if (focus !== null && focus !== undefined) {
      this.activateCard(focus);
    }

    // The reading, stamped after the browser has painted. A double
    // `requestAnimationFrame` is the ordinary way to land past the frame the
    // commit above produced: the first callback runs before that paint, the
    // second after it. This is the arc's one timer and it is diagnostic —
    // the no-polling rule is about the product watching itself, and nothing
    // here repeats.
    const totalMs = performance.now() - t0;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        deckTrace.record({
          kind: "space-switch-timing",
          fromSpaceId,
          toSpaceId: spaceId,
          outgoingCards,
          incomingCards,
          commitMs,
          restoreMs,
          totalMs,
          paintMs: performance.now() - t0,
        });
      });
    });
  };

  /**
   * Add a workspace, put the user in it, and stand its doors up ([P05]).
   *
   * Creating and activating are one gesture because the user asked for a place
   * to work, not for a row in a list. And the new deck gets its factory rail
   * immediately rather than through {@link factoryRailPending} — that latch
   * waits for a first card, and a workspace whose Workspaces card is not
   * standing has no door back except ⌃⌘W and the Window menu.
   *
   * `name` is the caller's when it has one (the Workspaces card's rename-on-
   * create), and otherwise {@link nextSpaceName}'s.
   *
   * Returns the new space's id.
   */
  public createSpace = (name?: string): string => {
    const trimmed = name?.trim();
    const chosen =
      trimmed !== undefined && trimmed.length > 0
        ? trimmed
        : nextSpaceName(this.spacesStore.list.map((s) => s.name));
    const id = crypto.randomUUID();
    // The new workspace wears the theme of the one being left, so creating
    // one never changes what is on screen.
    const theme = this.spacesStore.activeTheme();
    this.spacesStore.insert({
      id,
      name: chosen,
      deck: buildDefaultLayout(),
      ...(theme !== undefined ? { theme } : {}),
    });
    this.activateSpace(id);
    // The latch would otherwise stand a SECOND rail the first time a card
    // opened here: it is armed at boot by an empty boot deck and this deck is
    // empty too, so it is still waiting when we hand it a rail it did not ask
    // for. Disarm before standing ours.
    this.factoryRailPending = false;
    this._createFactoryRail();
    return id;
  };

  /**
   * Rename a workspace. Trims; refuses a name that is empty after trimming,
   * because a row with no name is a row nobody can address.
   */
  public renameSpace = (spaceId: string, name: string): void => {
    if (this.spacesStore.rename(spaceId, name)) this.scheduleSave();
  };

  /**
   * Copy a workspace's layout and sidebars into a new one named `<name> copy`,
   * appended after the source and NOT activated ([P06]).
   *
   * The copy's shape is {@link duplicatedDeck}'s, which is where the argument
   * for copying so little is written down. Not activating is the other half of
   * the same reading: Duplicate is a gesture about the list, so the user stays
   * where they were working.
   *
   * Returns the new space's id, or `null` when `spaceId` names no space.
   */
  public duplicateSpace = (spaceId: string): string | null => {
    const index = this.spacesStore.indexOf(spaceId);
    if (index === -1) {
      console.warn(`duplicateSpace: no space with id "${spaceId}"`);
      return null;
    }
    const source = this.spacesStore.list[index];
    const deck = duplicatedDeck(
      source.deck ?? this.deckState,
      () => crypto.randomUUID(),
    );
    if (isDevEnv()) {
      validateDeckState(deck);
    }
    const id = crypto.randomUUID();
    this.spacesStore.insert(
      {
        id,
        name: `${source.name} copy`,
        deck,
        ...(source.theme !== undefined ? { theme: source.theme } : {}),
      },
      index + 1,
    );
    this.scheduleSave();
    return id;
  };

  /**
   * Record the theme a workspace wears. Writes the record and nothing else:
   * putting a theme on screen is the theme provider's work, and it reports
   * back here once the active workspace's theme is applied.
   */
  public setSpaceTheme = (spaceId: string, theme: string): void => {
    if (this.spacesStore.setTheme(spaceId, theme)) this.scheduleSave();
  };

  /**
   * Choose a workspace's theme from outside the Theme menu — the swatch on
   * its row. For the workspace on screen this is the menu's own path: the
   * theme is applied, and the record follows once it is. For a parked one
   * only the record moves, and nothing repaints until the user goes there.
   */
  public chooseSpaceTheme = (spaceId: string, theme: string): void => {
    if (spaceId !== this.spacesStore.activeSpaceId) {
      this.setSpaceTheme(spaceId, theme);
      return;
    }
    void applyTheme(theme).then((applied) => {
      if (applied) this.setSpaceTheme(spaceId, theme);
    });
  };

  /**
   * Give every workspace the active workspace's theme. The active one already
   * wears it, so nothing on screen changes; a no-op when they all do.
   */
  public applyThemeToAllSpaces = (): void => {
    if (this.spacesStore.applyActiveThemeToAll()) this.scheduleSave();
  };

  /**
   * How many live sessions a workspace holds ([P07]).
   *
   * **The one definition, read by the confirm and by the close loop alike.** A
   * card counts when it holds a binding — it was restored in this run and its
   * session is on the wire — or when the bindings-ledger cache ([P08]) has a
   * row for it saying the session is alive, has a transcript, or has taken a
   * turn. A future signal added to one reader and not the other reopens
   * exactly the hole `closeUnboundCard` was added to close, so there is
   * deliberately no second copy of this test anywhere.
   */
  public spaceHoldsLiveSessions = (spaceId: string): number => {
    const deck = this.getSpaceDeck(spaceId);
    if (deck === null) return 0;
    let count = 0;
    for (const card of deck.cards) {
      if (card.componentId !== SESSION_COMPONENT_ID) continue;
      if (cardSessionBindingStore.getBinding(card.id) !== undefined) {
        count += 1;
        continue;
      }
      if (cachedRowIsLive(spaceBindingsLedgerStore.get(card.id))) count += 1;
    }
    return count;
  };

  /**
   * How many cards a workspace holds — its panes less its rail's
   * ({@link workspacePanes}). Unfiltered: this is what a delete would close
   * of the user's, whatever the Workspaces list is narrowed to.
   */
  public spaceCardCount = (spaceId: string): number => {
    const deck = this.getSpaceDeck(spaceId);
    return deck === null ? 0 : workspacePanes(deck).length;
  };

  /**
   * Remove a workspace and everything in it ([P07]).
   *
   * Refuses the last one: a deck has to be somewhere, and a Tug instance with
   * no workspace has nowhere to render. The caller shows the reason.
   *
   * Deleting the ACTIVE workspace activates its nearest neighbour first — the
   * previous one, else the next — so the deck being torn down is a parked one
   * by the time it is torn down.
   *
   * Then the two close paths, which are disjoint by construction:
   *
   * 1. Cards with **no** binding but a live cached row go through
   *    `cardServicesStore.closeUnboundCard` with the row's session id. These
   *    are the never-activated workspace's sessions, and destruction alone
   *    would send nothing for them — see that method for the whole argument.
   * 2. Every card, bound or not, gets `notifyCardWillBeginDestruction`, which
   *    is what makes the services store send `close_session` for the bound
   *    ones and dispose their services.
   *
   * No save callback is flushed first: these cards are not mounted, so there
   * is nothing live to capture — what they had was captured when the
   * workspace was parked. Their bags and component-state registries are
   * dropped here; their cardstate rows are swept by `pruneOrphanedCardDefaults`
   * at the next boot, as a closed card's rows are today.
   *
   * Returns whether the workspace was deleted.
   */
  public deleteSpace = (spaceId: string): boolean => {
    const index = this.spacesStore.indexOf(spaceId);
    if (index === -1) {
      console.warn(`deleteSpace: no space with id "${spaceId}"`);
      return false;
    }
    const spaces = this.spacesStore.list;
    if (spaces.length === 1) {
      console.warn(`deleteSpace: refusing to delete the last workspace`);
      return false;
    }
    if (spaceId === this.spacesStore.activeSpaceId) {
      const neighbour = spaces[index - 1] ?? spaces[index + 1];
      this.activateSpace(neighbour.id);
    }
    const doomed = spaces[index];
    const deck = doomed.deck;
    if (deck === null) {
      console.warn(`deleteSpace: "${spaceId}" is still active after the swap`);
      return false;
    }

    for (const card of deck.cards) {
      if (card.componentId !== SESSION_COMPONENT_ID) continue;
      if (cardSessionBindingStore.getBinding(card.id) !== undefined) continue;
      const row = spaceBindingsLedgerStore.get(card.id);
      if (!cachedRowIsLive(row)) continue;
      cardServicesStore.closeUnboundCard(card.id, row.session_id);
    }

    for (const card of deck.cards) {
      this.cardLifecycle.notifyCardWillBeginDestruction(card.id);
      this.discardComponentStatePreservationRegistry(card.id);
      this.cardStates.delete(card.id);
    }

    this.spacesStore.remove(spaceId);
    this.scheduleSave();
    return true;
  };

  /**
   * Put the workspaces in `order`.
   *
   * Ids the list does not hold are ignored, and spaces `order` does not
   * mention keep their current relative order at the end — so a drag that
   * names only the rows it moved is a complete instruction, and a stale order
   * from a surface that has not seen a new workspace yet cannot lose it.
   */
  public reorderSpaces = (order: readonly string[]): void => {
    this.spacesStore.reorder(order);
    this.scheduleSave();
  };

  /**
   * Move `cardId` — with the pane it sits in — into another workspace ([B07]).
   *
   * **The card's id does not change, and neither does anything keyed by it.**
   * That is the whole claim: a Session card carries its binding, its services
   * bag, its shell ledger and its `/btw` history under its card id, and a move
   * that minted a fresh one would be a close and an open wearing the word
   * "move". So nothing here fires destruction and nothing touches
   * `cardSessionBindingStore` — the record moves between two decks and the
   * card goes on being the same card, exactly as {@link activateSpace} keeps a
   * parked workspace's sessions alive.
   *
   * The three cases differ only in which side is on screen:
   *
   * - **Source is active.** A pane holding the first responder hands the bit
   *   off through `_flipFirstResponder`.
   * - **Destination is active.** The pane arrives visible rather than marked
   *   `arriving`: it is a settled card with a measured height, not a card
   *   opening, so there is nothing to hold a frame for. Cards the lifecycle
   *   has not constructed are announced, and the arrival is revealed.
   * - **Neither is active.** Two records change, and what renders depends on
   *   whether either workspace is mounted ([B06]).
   *
   * **Whichever case it is, the moving cards' panes are rebuilt**, because a
   * pane leaves one workspace's layer and is stood up in another's. Since
   * [B06] that is true of a workspace nobody is looking at, too: a visited
   * workspace stays mounted, so its panes are live React trees a move takes
   * down. So every case captures first ([L23]) — the bag lands in
   * `cardStates` for the replay on the far side, and a card whose host is
   * not mounted has no callback registered and costs nothing.
   *
   * A no-op when the card is already in `spaceId`, when no space has that id,
   * or when {@link moveCardBetweenDecks} refuses — a sidebar card's pane, or a
   * card no pane holds.
   *
   * Returns whether the card moved.
   */
  public moveCardToSpace = (cardId: string, spaceId: string): boolean => {
    const destRecord = this.spacesStore.find(spaceId);
    if (destRecord === undefined) {
      console.warn(`moveCardToSpace: no space with id "${spaceId}"`);
      return false;
    }
    const sourceId = this.spaceOf(cardId);
    if (sourceId === null) {
      console.warn(`moveCardToSpace: no space holds card "${cardId}"`);
      return false;
    }
    if (sourceId === spaceId) return false;
    const sourceRecord = this.spacesStore.find(sourceId);
    if (sourceRecord === undefined) return false;

    const sourceDeck = sourceRecord.deck ?? this.deckState;
    const destDeck = destRecord.deck ?? this.deckState;
    const moved = moveCardBetweenDecks(sourceDeck, destDeck, cardId);
    if (moved === null) return false;

    const movingPane = sourceDeck.panes.find((p) => p.cardIds.includes(cardId));
    const movingCardIds = movingPane?.cardIds ?? [cardId];

    // Capture before React takes the moving panes down ([L23]). Unconditional:
    // see the three cases above — the destination's layer stands the pane back
    // up whichever workspace was the one on screen.
    for (const id of movingCardIds) {
      this.invokeSaveCallback(id, "space-switch");
    }

    // Neither side is on screen: two records change, and only a mounted
    // workspace's layer re-renders.
    if (sourceRecord.deck !== null && destRecord.deck !== null) {
      sourceRecord.deck = moved.source;
      destRecord.deck = moved.dest;
      // A parked record the spaces snapshot may be holding has been
      // rewritten, and the canvas renders a mounted workspace's panes from
      // that snapshot ([B06]) — so the cached identity has to go.
      this.spacesStore.notify();
      this.scheduleSave();
      return true;
    }

    if (sourceRecord.deck === null) {
      destRecord.deck = moved.dest;
      const commit = (): void => {
        this.deckState = moved.source;
        this.spacesStore.notify();
        this.notify("moveCardToSpace");
        this.scheduleSave();
      };
      const responder = this.getFirstResponderCardId();
      if (responder !== null && movingCardIds.includes(responder)) {
        // The bit cannot follow the card out of the deck. Deactivate through
        // the flip so the will/did pair fires, then hand it to the frontmost
        // pane left standing — `moved.source` cleared `activePaneId` with the
        // pane, so without this the deck would come back with no responder at
        // all even when there is plenty left to hold it.
        this._flipFirstResponder(null, commit, "moveCardToSpace");
        const remaining = this.deckState.panes;
        if (remaining.length > 0) {
          this.activateCard(remaining[remaining.length - 1].activeCardId);
        }
      } else {
        commit();
      }
      return true;
    }

    // The destination is on screen: the pane arrives.
    sourceRecord.deck = moved.source;
    this.deckState = moved.dest;
    this.spacesStore.notify();
    this.notify("moveCardToSpace");
    this.scheduleSave();
    for (const id of movingCardIds) {
      if (!this.cardLifecycle.hasConstructed(id)) {
        this.cardLifecycle.notifyCardDidFinishConstruction(id);
      }
    }
    this._revealAfterArrival(cardId);
    return true;
  };

  public getVersion = (): number => this.stateVersion;

  // ---- CardLifecycleStore contract ----

  /**
   * The id of the currently-focused card (top of z-order). `null` when the
   * deck has no cards. Derived from deckState: the last stack in `stacks` is
   * the top of z-order, and its `activeCardId` is the focused card.
   */
  public getFocusedCardId = (): string | null => {
    const stacks = this.deckState.panes;
    if (stacks.length === 0) return null;
    return stacks[stacks.length - 1].activeCardId;
  };

  // ---- CardLifecycle pass-throughs ----

  public activateCard = (
    cardId: string,
    opts?: { reveal?: boolean },
  ): void => {
    const reveal = opts?.reveal ?? true;
    // A parked rail card cannot hold the keyboard — its frame is hidden and
    // inert — so activating one shows its rail first, and its whole side: a
    // rail never stands half-parked. Every door that names a parked card
    // (a sidebar card's own chord, a reveal link, the Layout card's row)
    // arrives here.
    this._unparkCard(cardId);
    this._flipFirstResponder(
      cardId,
      () => this._commitStandardFirstResponderFlip(cardId, reveal),
      "activateCard",
    );
    // Same-bit refresh: re-clicking the already-active card re-syncs
    // the responder chain against any drift. The flip helper skips
    // setResponderChainKey in the same-bit branch, so call it here.
    // Idempotent when the responder chain's key card is already cardId.
    this.cardLifecycle.setResponderChainKey(cardId);
  };

  /**
   * Deselect — the canvas-background click. Clears `activePaneId` so no card
   * is the composite first responder: every title bar drops to its
   * deactivated appearance and `getFirstResponderCardId()` returns null. The
   * responder chain has already been promoted to the deck-canvas root by the
   * pointerdown promotion, so this only clears the deck-level bit; the two
   * systems then agree that nothing is selected. No-op when nothing is active.
   */
  /**
   * The reveal an activation would have committed, on its own — see
   * `IDeckManagerStore.revealCard`. Reads the panes standing rather than a
   * commit's next panes, because nothing else is changing. Offsets are
   * session state and never serialized, so no save is scheduled.
   */
  public revealCard = (cardId: string): void => {
    const panes = this.deckState.panes;
    const pane = panes.find((p) => p.cardIds.includes(cardId));
    if (pane === undefined) return;
    const terms = this._revealTerms(pane.id, panes);
    if (Object.keys(terms).length === 0) return;
    this.deckState = { ...this.deckState, ...terms };
    this.notify("revealCard");
  };

  /**
   * The second of an arrival's two moves: the slide that brings a card that
   * has just been added into the band, one beat after the card itself lands.
   *
   * The WAIT is the whole point of the method, and it is measured in the eye
   * rather than in the scheduler. Standing the reveal off by a task is not
   * enough: two notifies inside one task are batched into one React render,
   * and even unbatched they land on adjacent frames, which is one event as far
   * as a reader is concerned. The card has to be ON SCREEN — risen into the
   * slot it landed in and held there — before the deck starts travelling, or
   * the file appears already in view and the only thing left to conclude is
   * that it opened somewhere it did not.
   *
   * The hold is the ARRIVE BEAT'S OWN COMPLETION, which is a fact about the
   * frame rather than a clock guessing at one. It used to be a timer set to
   * a constant of its own, chosen to be about as long as the entrance
   * took; that is a number that has to be re-guessed whenever the entrance
   * changes, and it is wrong in both directions — short, and the deck travels
   * over a card still fading in; long, and the reader waits on a card that
   * stopped moving a while ago. `onceCardDidArrive` waits for the thing
   * itself, and answers AT ONCE for a card with no settle to wait for, which
   * is the single-slot case where there was never anything to hold for.
   *
   * Landing after the arrival therefore means its own commit, its own
   * arrangement signature, and its own crossing ([P10]) — which is what makes
   * the slide a move the reader watches rather than a fact they are handed.
   *
   * Everything conditional about it belongs to {@link revealCard}, which is
   * the whole of the move: it commits nothing when the band already shows the
   * card whole, and answers silence for a card closed before the frame
   * arrived — a card the reader shut during the beat, say. A window-less host
   * — a manager driven with no DOM — takes the reveal synchronously, and needs
   * no branch of its own to do it: nothing marks an arrival there, so the
   * at-once path is the one that runs.
   */
  private _revealAfterArrival(cardId: string): void {
    this.cardLifecycle.onceCardDidArrive(cardId, () =>
      this.revealCard(cardId),
    );
  }

  /**
   * The second of a drop's two moves: the slide that shows a card whole in
   * the band it was just dropped into, one beat after the crossing that put
   * it there. The move's twin of {@link _revealAfterArrival}, and it waits the
   * same way — on the settle's own end rather than on a clock guessing at it.
   *
   * The mark is made here rather than in the commit because the commit does
   * not know the drop is owed a second beat; and it is guarded on a window for
   * the reason `addCard`'s is: the clearing half lives in the canvas's settle,
   * and a manager driven with no DOM would hold the mark forever. There the
   * reveal runs at once, which is the one-commit answer such a host wants.
   */
  private _revealAfterTravel(cardId: string): void {
    if (typeof window !== "undefined") {
      this.cardLifecycle.notifyCardWillTravel(cardId);
    }
    this.cardLifecycle.onceCardDidTravel(cardId, () => this.revealCard(cardId));
  }

  /** See `IDeckManagerStore.noteCardWillLand`. */
  public noteCardWillLand = (cardId: string): void => {
    this.cardLifecycle.notifyCardWillLand(cardId);
  };

  /** See `IDeckManagerStore.noteCardDidLand`. */
  public noteCardDidLand = (cardId: string): void => {
    this.cardLifecycle.notifyCardDidLand(cardId);
  };

  public deselectActiveCard = (): void => {
    if (this.deckState.activePaneId === undefined) return;
    this._flipFirstResponder(
      null,
      () => this._commitStandardFirstResponderFlip(null),
      "deselectActiveCard",
    );
  };

  /**
   * Read the composite first-responder bit: the active stack's
   * active card id, or `null` when no stack is active. At any
   * moment, exactly zero or one card is the first responder.
   */
  public getFirstResponderCardId = (): string | null => {
    const activePaneId = this.deckState.activePaneId;
    if (activePaneId === undefined) return null;
    const activeWin = this.deckState.panes.find((s) => s.id === activePaneId);
    return activeWin?.activeCardId ?? null;
  };

  /**
   * The pane standing in bullseye, or `null`. Delegates to
   * {@link bullseyePaneIdOf} so the store, the render path, and the menu
   * projection all read one rule — a derivation over the snapshot, never the
   * raw field.
   */
  public getBullseyePaneId = (): string | null =>
    bullseyePaneIdOf(this.deckState);

  /**
   * Put `paneId` in bullseye, or take it out when it is already there.
   *
   * Refuses a pane that does not exist, and refuses a RAIL. A sidebar card is
   * pinned to a deck edge and is holding a place open there; a posture that
   * centres it in the band takes it off the edge it is the reason for, and the
   * inset it leaves behind belongs to nothing. The rule lives here rather than
   * only at the doors, because this is the one call every door reaches — the
   * title bar's target button (which a rail's chrome no longer renders at all)
   * and View ▸ Bullseye (which `hostMenuState` reports as inapplicable on a
   * rail, so the row is dim rather than a press that does nothing).
   *
   * The "already there" comparison is against the DERIVED value, so a raw id
   * left behind by a focus move reads as "not bullseyed" and the press turns
   * bullseye on rather than off.
   *
   * Notifies but does not `scheduleSave()`: bullseye is a presentation, and
   * nothing persistable changed.
   */
  public toggleBullseye = (paneId: string): void => {
    const pane = this.deckState.panes.find((p) => p.id === paneId);
    if (!pane) return;
    const holdsRail = this.deckState.cards.some(
      (c) => pane.cardIds.includes(c.id) && isSidebarCard(c.componentId),
    );
    if (holdsRail) return;
    const next = this.getBullseyePaneId() === paneId ? undefined : paneId;
    this.deckState = { ...this.deckState, bullseyePaneId: next };
    this.notify("toggleBullseye");
  };

  /**
   * Release `paneId` from bullseye when it holds it — the geometry-shaped
   * exit door. Stated over the mutation rather than the caller: every path
   * that writes a pane's `position`, `size`, or `slot` calls this for the
   * pane it wrote, because an explicit "this pane is exactly this wide,
   * here" and a posture saying "this pane is comfy, centered" cannot both be
   * true, and the explicit gesture wins.
   *
   * `grep _clearBullseyeFor` lists every path honoring the rule. A new
   * geometry mutator that does not appear in that list is a bug.
   *
   * Writes the field only; callers fold it into the state replacement and the
   * `notify()` they were already making.
   */
  private _clearBullseyeFor(paneId: string): void {
    if (this.deckState.bullseyePaneId !== paneId) return;
    this.deckState = { ...this.deckState, bullseyePaneId: undefined };
  }

  /**
   * Release bullseye when the first responder leaves the pane holding it —
   * the focus-shaped exit door, made durable.
   *
   * The read accessor already derives bullseye away the moment focus moves,
   * so the posture *looks* correct without this. What it does not do on its
   * own is END: a raw id left behind starts matching again the moment focus
   * comes back to that pane, so clicking away and clicking back would
   * resurrect a posture the user never re-asked for. Bullseye is meant to be
   * left, not parked. (This is a correction to the plan's [P05], which
   * argued the lingering id was inert. It is not — `at0372`'s third exit door
   * is what proved it.)
   *
   * ONE site, called from `_flipFirstResponder` — the single entry point for
   * first-responder transitions — so this covers the click, the ⌘R picker,
   * the depth and lateral rings, every sidebar chord, the canvas-background
   * deselect, and any focus path added later, at no per-path cost. That is
   * the property the derived accessor was reaching for; the accessor stays
   * as the guard that makes a stale id unreadable in the window before the
   * flip commits, and for hand-built states that never flip at all.
   *
   * Membership is read pre-commit, and asks whether the bullseyed pane hosts
   * the INCOMING responder — so switching tabs inside the bullseyed pane
   * keeps the posture, which is the right answer: the user is still working
   * in the card they bullseyed. A commit that also moves cards between panes
   * can make this answer conservatively; erring toward clearing is the safe
   * direction, and the accessor catches the other one.
   *
   * Folded into the state the commit is about to replace and notify, exactly
   * as {@link _clearBullseyeFor} is — no extra `notify()`, no `scheduleSave()`.
   */
  private _clearBullseyeOnFocusFlip(newFR: string | null): void {
    const paneId = this.deckState.bullseyePaneId;
    if (paneId === undefined) return;
    const pane = this.deckState.panes.find((p) => p.id === paneId);
    if (pane !== undefined && newFR !== null && pane.cardIds.includes(newFR)) {
      return;
    }
    this.deckState = { ...this.deckState, bullseyePaneId: undefined };
  }

  public observeCardDidFinishConstruction = (
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): (() => void) =>
    this.cardLifecycle.observeCardDidFinishConstruction(cardId, callback);

  public observeCardDidActivate = (
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): (() => void) => this.cardLifecycle.observeCardDidActivate(cardId, callback);

  public observeCardDidDeactivate = (
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): (() => void) =>
    this.cardLifecycle.observeCardDidDeactivate(cardId, callback);

  public observeCardWillBeginDestruction = (
    cardId: string | null,
    callback: CardLifecycleObserver,
  ): (() => void) =>
    this.cardLifecycle.observeCardWillBeginDestruction(cardId, callback);

  public attachResponderChainManager = (
    manager: CardLifecycleManager | null,
  ): void => {
    this.cardLifecycle.setManager(manager);
  };

  /**
   * When true, DeckManager starts with an empty in-memory DeckState and
   * never issues tugbank reads or writes. See test-mode semantics
   * and design decision [D02]: every `putLayout` / `putCardState` call site is
   * guarded with `if (this.testMode) return;` so test-mode sessions never
   * mutate the user's persisted deck. The focused card has no write of its own
   * to guard from v5 on — it rides the layout blob, behind `putLayout`.
   *
   * The sole source of state in test mode is {@link seedDeckState}; the
   * boot path ignores any `initialLayout` / `initialCardStates` /
   * `initialFocusedCardId` arguments when `testMode` is true.
   *
   * Release builds never reach this code path because the flag is set
   * only by the DEBUG-gated bridge ([D03]).
   */
  private readonly testMode: boolean;

  /**
   * True when the boot honored the persisted boot state and found no layout
   * at all — a factory-fresh install. The factory deck stands both rails open
   * at their pins — every card of {@link FACTORY_RAILS} — but not until it has
   * a card to stand beside
   * ({@link factoryRailPending}). Stays false under the ordinary test-mode
   * boot, which discards the boot state and starts empty for the harness to
   * seed.
   */
  private factoryFresh = false;

  /**
   * The factory deck's rail, waiting for the deck's first card. A brand-new
   * install opens onto the setup wizard over a bare canvas, and a rail of
   * empty cards beside it is a promise about work that does not exist yet.
   * The first card the user opens is the cue for the whole rail — every card
   * in {@link FACTORY_RAIL_ORDER} — to stand up beside it.
   */
  private factoryRailPending = false;

  /**
   * Whether the constructor honored the tugbank-sourced boot arguments. False
   * only under the ordinary test-mode boot. {@link loadLayout} reads it to
   * tell a factory-fresh install from a deliberately-emptied test deck.
   */
  private bootStateHonored = true;

  constructor(
    container: HTMLElement,
    connection: TugConnection,
    initialLayout?: object,
    initialTheme?: ThemeName,
    initialCardStates?: Map<string, CardStateBag>,
    initialFocusedCardId?: string,
    options?: { testMode?: boolean; fallbackTheme?: ThemeName },
  ) {
    this.container = container;
    this.connection = connection;
    this.rateLimitStore = new RateLimitStore(connection);
    this.usageStore = new UsageStore(connection);
    this.testMode = options?.testMode === true;
    this.persistence = new LayoutPersistence({
      testMode: this.testMode,
      spacesState: () => this.spacesState(),
    });
    // Test mode: discard any tugbank-sourced boot arguments so the deck
    // starts empty. The harness drives state exclusively via
    // `seedDeckState`; silently honoring a stray pre-populated layout
    // would couple test scenarios to whatever happened to be in
    // tugbank when the run started. The `__tugRestoreInTestMode`
    // escape hatch re-enables the boot restore for quit-and-relaunch
    // tests that pair a per-test `TUGBANK_PATH` with
    // `__tugPersistInTestMode` — there the persisted state is the
    // test's own, and the constructor restore IS the code under test.
    const dropBootState = this.testMode && !shouldRestoreInTestMode();
    this.bootStateHonored = !dropBootState;
    this.initialLayout = dropBootState ? null : (initialLayout ?? null);
    this.initialTheme = initialTheme ?? BASE_THEME_NAME;
    this.fallbackTheme = options?.fallbackTheme;

    this.cardStates = new CardStateCache(
      {
        putCardState: (cardId, bag, putOptions) =>
          this.persistence.putCardStateGuarded(cardId, bag, putOptions),
      },
      initialCardStates && !dropBootState ? initialCardStates : undefined,
    );

    this.initialFocusedCardId = dropBootState ? undefined : initialFocusedCardId;

    container.style.position = "relative";
    this.containerSizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(this.dropContainerSize) : null;
    this.containerSizeObserver?.observe(container);
    window.addEventListener("resize", this.dropContainerSize);

    this.reactRoot = createRoot(container);

    this.handlePaneMoved = this.movePane.bind(this);
    this.handlePaneClosed = this._closePane.bind(this);
    this.cardLifecycle = new CardLifecycle(this);
    registerCardLifecycle(this.cardLifecycle);
    this.appLifecycle = new AppLifecycle();
    registerAppLifecycle(this.appLifecycle);
    this.sheetLifecycle = new SheetLifecycle();
    registerSheetLifecycle(this.sheetLifecycle);
    this.bannerLifecycle = new BannerLifecycle();
    registerBannerLifecycle(this.bannerLifecycle);
    // Expose this store to non-React singletons (notably `selectionGuard`,
    // which `ResponderChainProvider` attaches from a `useLayoutEffect`
    // that sits outside the `DeckManagerContext` provider and so cannot
    // reach the store through React context).
    registerDeckStore(this);
    this.lifecycleCascade = installLifecycleCascade(
      this.cardLifecycle,
      this.appLifecycle,
    );
    this.addCardToPane = this._addCardToPane.bind(this);
    this.removeCard = this._removeCard.bind(this);
    this.setActiveCardInPane = this._setActiveCardInPane.bind(this);
    this.reorderCardInPane = this._reorderCardInPane.bind(this);
    this.detachCard = this._detachCard.bind(this);
    this.moveCardToPane = this._moveCardToPane.bind(this);
    this.setPaneWidth = this._setPaneWidth.bind(this);

    this.deckState = {
      ...this.loadLayout(),
      // `hasFocus` is session-only state; the loaded layout carries a
      // placeholder value. Overwrite it with the live foreground
      // reading so the selector is correct on the very first render.
      hasFocus:
        typeof document !== "undefined" && typeof document.hasFocus === "function"
          ? document.hasFocus()
          : true,
    };

    // The focused card is a field on the SPACE from layout v5 on. A space
    // migrated from a pre-v5 blob has none, and its pointer arrives instead
    // through the legacy `dev.tugapp.deck.state` row this argument carries —
    // so adopt it once, here, and let the row go unwritten from now on
    // (Spec S02). A space that already names a focused card is authoritative:
    // the row is older than the blob beside it.
    const bootSpace = this.spacesStore.active();
    if (bootSpace !== undefined) {
      if (bootSpace.focusedCardId === undefined) {
        if (this.initialFocusedCardId !== undefined) {
          bootSpace.focusedCardId = this.initialFocusedCardId;
        }
      } else {
        this.initialFocusedCardId = bootSpace.focusedCardId;
      }
    }

    // Seed the DOM foreground projection from the live reading above, so the
    // focus language is correctly quiet/lit on the very first paint (setHasFocus
    // only fires it on a subsequent transition).
    this.reflectAppActive(this.deckState.hasFocus);

    // Install window focus/blur listeners exactly once per JS context.
    // Safe to call unconditionally — the module-scope flag short-circuits
    // subsequent constructions.
    installDeckStoreFocusListeners();

    // Fire CONSTRUCTION for every card loaded from the saved layout so the
    // lifecycle's `constructedCards` set matches reality and later-subscribing
    // delegates receive initial-sync correctly.
    for (const card of this.deckState.cards) {
      this.cardLifecycle.notifyCardDidFinishConstruction(card.id);
    }

    // Factory default: a deck with no persisted layout opens with its rail
    // standing at its pin — but it holds until the deck has its first card,
    // so the setup wizard's first launch is not staged over an empty rail.
    if (this.factoryFresh) {
      this.factoryRailPending = true;
    }

    this.reactRoot.render(
      composeProviders(
        [
          [
            TugThemeProvider,
            {
              // The theme on screen is the active workspace's, so a theme
              // chosen and applied is a theme that workspace now wears.
              onThemeApplied: (theme: string) =>
                this.setSpaceTheme(this.spacesStore.activeSpaceId, theme),
            },
          ],
          [TugTooltipProvider, null],
          [ErrorBoundary, null],
          [ResponderChainProvider, null],
          [DeckManagerContext.Provider, { value: this }],
          [UsageContext.Provider, { value: this.usageStore }],
          [CardLifecycleContext.Provider, { value: this.cardLifecycle }],
          [AppLifecycleContext.Provider, { value: this.appLifecycle }],
          [SheetLifecycleContext.Provider, { value: this.sheetLifecycle }],
          [BannerLifecycleContext.Provider, { value: this.bannerLifecycle }],
          [TugAlertProvider, null],
          [TugBulletinProvider, null],
        ],
        React.createElement(
          React.Fragment,
          null,
          React.createElement(TugBannerProvider, {
            connection: this.connection,
          }),
          React.createElement(RateLimitBulletinBridge, {
            store: this.rateLimitStore,
          }),
          React.createElement(DeckCanvas, {}),
          // App-wide blocking "update macOS" gate. Opens only when the host
          // version is known-below its line's floor; takes precedence over
          // ConfigureTug (which suppresses itself while the gate is open) so the
          // two app-modals never stack (Spec S02). Renders nothing otherwise.
          React.createElement(TugVersionGate, {}),
          // App-wide blocking restore gate. A cold restore's reveal is one
          // uninterruptible task on the thread every card shares, so the app
          // answers nothing while it runs; the gate says so for exactly that
          // long instead of painting a live-looking deck that drops input.
          // Suppresses itself under the version gate (Spec S02) and renders
          // nothing once the restores land.
          React.createElement(TugRestoreGate, {}),
          // App-wide blocking setup wizard. Covers the deck until Claude Code
          // is installed, signed in, and the first session is opened — auth is
          // strictly required for an AI IDE. Renders nothing once set up.
          React.createElement(ConfigureTug, {}),
          // App-level logout orchestrator (renders nothing). Watches the
          // logout-request nonce; on request runs confirm → interrupt every
          // turn → `claude_logout`, then ConfigureTug reopens for re-login (or a
          // "couldn't log out" alert on failure). Sibling of ConfigureTug so it
          // shares the TugAlert singleton and the deck context.
          React.createElement(TugLogout, {}),
          // Gate in front of the Tug-menu "Configure Tug…" item (renders nothing).
          // Watches the setup-request nonce; opens the wizard outright when
          // nothing is running, otherwise confirms → interrupts every turn
          // first, so the app-modal never lands on top of live work.
          React.createElement(ConfigureTugRequest, {}),
        ),
      ),
    );

    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("beforeunload", this.handleBeforeUnload);

  }

  // ---- App-foreground tracking ([A1]) ----

  /**
   * Flip the session-only `hasFocus` slice when the window gains or
   * loses OS foreground. Idempotent: a no-op when the bit is already
   * at `value`, so spurious duplicate events don't churn React
   * subscribers. Called from the module-scope listeners installed by
   * {@link installDeckStoreFocusListeners}; tests may call this
   * directly to simulate focus transitions without dispatching DOM
   * events.
   */
  public setHasFocus = (value: boolean): void => {
    if (this.deckState.hasFocus === value) return;
    this.deckState = { ...this.deckState, hasFocus: value };
    this.reflectAppActive(value);
    this.notify("setHasFocus");
  };

  /**
   * Project the OS-foreground bit onto `<html>` as `data-app-active`, the
   * DOM signal the keyboard focus language gates on so the ring goes quiet
   * while the app is backgrounded (focus-ring.css `[data-app-active="false"]`).
   * Pure DOM, no React state ([L06]); `DeckState.hasFocus` stays the
   * authoritative bit and this is its appearance projection.
   */
  private reflectAppActive(active: boolean): void {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute(
      "data-app-active",
      active ? "true" : "false",
    );
  }

  // ---- Store notification ----

  /**
   * Run `fn` as one gesture: every `notify()` and `scheduleSave()` it
   * provokes is held until it returns, and exactly one of each fires on
   * the way out, over the final state.
   *
   * A drop-zone release is several mutations — the autoscroll's offset
   * commit, the zone's own commit, and the activation raise that
   * `movePaneToSlot` performs inside `transferFocusForActivation` — and
   * each one notifying separately makes the deck canvas re-read the
   * arrangement signature that many times. A changed signature arms the
   * settle; an arm landing while a previous settle is still in flight
   * retargets it mid-tween. One gesture is one arrangement change, so it
   * gets one notify.
   *
   * What is batched is *observation*, not mutation: the writes inside
   * `fn` run in their existing order against `deckState`, and lifecycle
   * will/did brackets are untouched — a card's resize episode still
   * reads pre-move geometry on the will side.
   *
   * Re-entrant: a nested call joins the outer batch and defers to it,
   * which it must, because `movePaneToSlot` itself batches nothing and
   * calls straight through to `activateCard`.
   *
   * Exception-safe: a throw inside `fn` still closes the batch and still
   * fires the pending notify, so a failed gesture cannot leave
   * subscribers looking at a state nobody told them about.
   */
  batchGesture = <T,>(fn: () => T): T => {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) {
        const caller = this.batchPendingNotify;
        const landing = this.batchPendingLanding ?? "cross";
        const save = this.batchPendingSave;
        this.batchPendingNotify = null;
        this.batchPendingLanding = null;
        this.batchPendingSave = false;
        if (caller !== null) this.notify(caller, landing);
        if (save) this.scheduleSave();
      }
    }
  };

  /**
   * Depth of the enclosing {@link batchGesture} calls; 0 when no gesture
   * transaction is open. `batchPendingNotify` holds the caller tag of the
   * first deferred notify (the one that opened the gesture, which is the
   * useful attribution) or `null` when nothing has asked to notify.
   *
   * `batchPendingLanding` resolves the gesture's landing the same way, with
   * one asymmetry: any `"cross"` in the batch wins, so a gesture stays `"cut"`
   * only when every commit in it said so ([B02]). Crossing a frame that is
   * already in place is a no-op tween; cutting one that is not is the defect,
   * so the resolution errs toward the harmless answer.
   */
  private batchDepth = 0;
  private batchPendingNotify: string | null = null;
  private batchPendingLanding: CommitLanding | null = null;
  private batchPendingSave = false;

  /**
   * The flow offset {@link previewFlowOffset} last drew and no commit has yet
   * consumed. See {@link getDrawnFlowOffset}.
   */
  private drawnFlowOffset: number | null = null;

  /**
   * The hand's velocity handed to the next flow commit. See
   * {@link getDrawnFlowVelocity}.
   */
  private drawnFlowVelocity: number | null = null;

  /**
   * Fire every subscriber over the current state.
   *
   * `caller` is the mutating method's own name, stamped by each call
   * site and carried into the motion census (`deck-trace`'s
   * `store-notify` record). A gesture is supposed to cost one notify;
   * when one costs more, the census names the contributors instead of
   * reporting an anonymous count.
   *
   * `landing` is how the commit says it wants to land, and it is the
   * mutation's to declare rather than the settle's to reconstruct ([B01]).
   * It defaults to `"cross"` — what every arrangement change does — so a call
   * site that says nothing keeps the behaviour it had.
   */
  private notify(caller = "untagged", landing: CommitLanding = "cross"): void {
    if (this.batchDepth > 0) {
      // Inside a gesture transaction: record that someone wants
      // subscribers told, and let the outermost batch tell them once.
      // The first caller wins the tag — it is the mutation that opened
      // the gesture, and the census reads better naming that than the
      // incidental last one.
      this.batchPendingNotify ??= caller;
      // The landing is not simply first-wins: the opener seeds it, and any
      // later `"cross"` takes it over, so the batch is `"cut"` only when every
      // commit in it is. See `batchPendingLanding`.
      this.batchPendingLanding =
        this.batchPendingLanding === null || landing === "cross"
          ? landing
          : this.batchPendingLanding;
      return;
    }
    // Invariant 7, enforced rather than merely asserted: no pane commits with
    // its title bar above the deck top. Every mutation in this class lands
    // through here, so one clamp covers all of them — including the ones no
    // gesture guards (restore from a persisted layout, detach, arrange). The
    // clamp returns the same object when nothing was out of bounds, so the
    // common path costs one pass and no allocation.
    this.deckState = clampPanesToDeck(this.deckState);
    // And no arriving mark outlives its pane: a card closed before its
    // reveal is removed by a writer that is not the arrival's own, so the
    // mark is swept here, where every removal lands ([B08]).
    this.deckState = sweptArriving(this.deckState);
    // Dev-only invariant check. Fires after every mutation so violations
    // surface at the site that produced them rather than downstream where
    // the symptom manifests. Guarded so production builds pay no cost.
    if (isDevEnv()) {
      validateDeckState(this.deckState);
    }
    this.stateVersion += 1;
    deckTrace.record({
      kind: "store-notify",
      caller,
      version: this.stateVersion,
      landing,
    });
    // Host menu state rides the ordinary subscriber list: the
    // `host-menu-state` aggregator subscribes at boot (main.tsx) and
    // projects each notification into the `menuState` push the Swift
    // host validates its menus from.
    const priorVote = this.inFlightDeferralVote;
    const vote = { flush: false };
    this.inFlightDeferralVote = vote;
    // The motion gate this commit arrived under, if one is closed.
    const gateBefore = gestureScope.motionGate();
    // Keys, not entries: the label is the call site's name for its door and
    // the thing the [B04] audit in `deck-manager-store.ts` lists by, not
    // something this pass reads — the per-subscriber marks that used to read
    // it were six pairs on every commit and are gone ([B07]).
    for (const cb of this.syncSubscribers.keys()) {
      cb(landing);
    }
    // A commit consumes the drawn flow offset whoever made it: the sync arm
    // above has read it, and the layer re-writes the strip's offset from the
    // store on the React commit that follows, so the preview is no longer
    // what the screen shows. Cleared here rather than in `setFlowOffset`
    // because a reveal or a retune moves the strip too, and a batched commit
    // reaches its arm only at this flush.
    this.drawnFlowOffset = null;
    this.drawnFlowVelocity = null;
    this.inFlightDeferralVote = priorVote;
    // Under reduced motion there is no tween to keep the commit out of, and a
    // deferral would only put the snapped layout one frame behind the gesture.
    // A sync subscriber that voted — a retarget's `arm` ([B01]) — is told the
    // same way: the residue it just handed back is only safe while the Last
    // pass follows it before anything paints.
    if (vote.flush || !isTugMotionEnabled()) {
      tellReactNow(() => this.subscribers.forEach((cb) => cb(landing)));
      return;
    }
    // A commit that arrived mid-motion and moved no settle — the arm left the
    // same gate closed — is told after the land, with everything else the
    // gate holds. A commit that did move one opened that gate in its arm: a
    // retarget is told at once (the vote above), and a fresh settle defers
    // past its own first paint as always, which is its set-up.
    if (gateBefore !== null && gestureScope.motionGate() === gateBefore) {
      this._scheduleGatedNotify(landing);
      return;
    }
    this._scheduleDeferredNotify(landing);
  }

  refresh(): void {
    this.notify("refresh");
  }

  getDeckState(): DeckState {
    return this.getSnapshot();
  }

  sendControlFrame(action: ControlAction, params?: Record<string, unknown>): void {
    this.connection.sendControlFrame(action, params);
  }

  /**
   * App-level account-global quota store, for the `__tug` test surface's
   * `ingestRateLimit` seam ([#step-3.5]). Production code reaches it only
   * through the mounted `RateLimitBulletinBridge`.
   */
  getRateLimitStore(): RateLimitStore {
    return this.rateLimitStore;
  }

  /**
   * App-level account-global usage store, for the `__tug` test surface's
   * `ingestUsage` seam. Production code reaches it through {@link UsageContext}.
   */
  getUsageStore(): UsageStore {
    return this.usageStore;
  }

  // ---- Card / stack management () ----

  /**
   * Add a new card from the registry, wrapped in a new single-card stack at
   * the cascaded position. Returns the generated card id, or null if no
   * registration is found for `componentId`.
   *
   * If the registration carries `defaultCards`, the stack is seeded with one
   * card per template (fresh UUIDs); otherwise a single card is created from
   * `defaultMeta`.
   *
   * `initialContent`, when provided, is seeded into the new card's
   * `CardStateBag.content` BEFORE the deck-state commit, so the card
   * mounts through the same restore path a reloaded card takes — its
   * `useCardStatePreservation.onRestore` receives the payload. This is
   * how parameterized openers (e.g. `open-file` seeding a path) hand
   * initial state to a card without a side channel.
   *
   * `options.origin` names the card the gesture was made in. Under a
   * multi-slot arrangement the deck chooses the new card's slot itself
   * ({@link openingSlotFor}), ranked from that card when it holds a slot, from
   * the first responder when it does not, and from the deck otherwise. A
   * caller says where the gesture came from, never which slot to take.
   */
  addCard(
    componentId: string,
    initialContent?: unknown,
    options?: {
      /** The card the gesture was made in, when there is one. */
      origin?: string | null;
      /**
       * `"bound"` when the caller binds the card in the same gesture — a
       * resume, a command run in a new session — so the card never shows
       * the form its registration declares for an UNBOUND opening. No form
       * is readied or measured, no bid is written, and the card lands in
       * this call at its ordinary policy.
       */
      opening?: "bound";
    },
  ): string | null {
    const registration = getRegistration(componentId);
    if (!registration) {
      console.warn(
        `[DeckManager] addCard: no registration found for componentId "${componentId}". ` +
          `Call registerCard() before addCard().`,
      );
      return null;
    }

    this.claimFactoryRail(componentId);

    const paneId = crypto.randomUUID();
    const sizePolicy = getSizePolicy(componentId);
    // Clamp preferred width AND height to 90% of the live canvas so
    // registrations with large preferred sizes (e.g. session-card at
    // 900x1200) open at a sensible ceiling on small canvases instead
    // of pushing past the viewport. Each dimension is also floored at
    // the policy `min` so a tiny canvas never produces a sub-minimum
    // card. With both dimensions capped, the cascade origin (10,10)
    // plus a 0.9-canvas card always lands inside the canvas.
    const canvasWidthForCap = this.container.clientWidth || 800;
    const canvasHeightForCap = this.container.clientHeight || 600;
    // A reading card opens at the width the deck is set to rather than at a
    // number frozen into its registration, so the first card of a session
    // arrives at the width the user last chose for content
    // (`takesContentWidth`). The registered preferred width is what a card that
    // declares nothing keeps.
    const openingPreset = takesContentWidth(componentId)
      ? this.deckState.imposition.contentWidth ?? DEFAULT_CONTENT_WIDTH
      : undefined;
    const openingWidth =
      openingPreset === undefined
        ? sizePolicy.preferred.width
        : resolveContentWidthPx(
            openingPreset,
            sizePolicy.min.width,
            sizePolicy.max?.width,
          );
    const cappedPreferredWidth = Math.min(
      openingWidth,
      Math.max(sizePolicy.min.width, Math.floor(canvasWidthForCap * 0.9)),
    );
    const cappedPreferredHeight = Math.min(
      sizePolicy.preferred.height,
      Math.max(sizePolicy.min.height, Math.floor(canvasHeightForCap * 0.9)),
    );
    // Dialog-like cards (registration `placement: "center"`) open
    // centered in the live canvas; everything else walks the cascade.
    const position =
      registration.placement === "center"
        ? {
            x: Math.max(0, Math.floor((canvasWidthForCap - cappedPreferredWidth) / 2)),
            y: Math.max(0, Math.floor((canvasHeightForCap - cappedPreferredHeight) / 2)),
          }
        : nextCascadePosition(
            this.deckState.panes.map((pane) => pane.position),
            { width: this.container.clientWidth, height: this.container.clientHeight },
            { width: cappedPreferredWidth, height: cappedPreferredHeight },
          );

    const seededCards: CardState[] = [];
    if (registration.defaultCards && registration.defaultCards.length > 0) {
      for (const template of registration.defaultCards) {
        seededCards.push({
          id: crypto.randomUUID(),
          componentId: template.componentId,
          title: template.title,
          closable: template.closable,
        });
      }
    } else {
      seededCards.push({
        id: crypto.randomUUID(),
        componentId,
        title: registration.defaultMeta.title,
        closable: registration.defaultMeta.closable !== false,
      });
    }

    const firstCardId = seededCards[0].id;
    if (initialContent !== undefined) {
      this.cardStates.seed(firstCardId, { content: initialContent });
    }
    // Under a multi-slot arrangement a new card joins it at a slot rather
    // than walking the cascade — the arrangement is the user's stated intent
    // for the whole deck, and a fresh card landing askew across it would be
    // the deck ignoring it. Which slot is the deck's one rule to answer
    // ({@link openingSlotFor}), from the card the gesture came from. One-up is
    // the deck's resting state rather than a chosen arrangement, so it claims
    // nothing: a new card cascades as it always did and takes the single slot
    // only by being put there. Centered dialog cards stay centered under
    // every kind; they are not part of the arrangement.
    const opening =
      slotCount(this.deckState.imposition.kind ?? DEFAULT_IMPOSITION_KIND) > 1 &&
      registration.placement !== "center"
        ? this.openingSlotFor(options?.origin ?? null)
        : null;
    const win: TugPaneState = {
      id: paneId,
      position,
      size: { width: cappedPreferredWidth, height: cappedPreferredHeight },
      cardIds: seededCards.map((c) => c.id),
      activeCardId: firstCardId,
      title: registration.defaultTitle ?? "",
      acceptsFamilies: registration.acceptsFamilies ?? ["standard"],
      // The stamp records the preset the card actually opened at, so the width
      // popup's check is true from the first frame. A card the canvas cap pulled
      // in off its preset gets no stamp — it is at a width no row names.
      ...(openingPreset !== undefined && cappedPreferredWidth === openingWidth
        ? { widthPreset: openingPreset }
        : {}),
      ...(opening !== null ? { slot: opening.slot } : {}),
    };

    // Whether the card ARRIVES HIDDEN ([B01]): a card type whose card at the
    // instant it opens is a sheet declares `openingForm`, and an unbound one
    // is that sheet and nothing else. Its height depends on what the sheet
    // draws — rows a store answers lazily, synopses on their own schedule —
    // so nothing read before the commit can know it. The pane is committed
    // now, marked arriving, drawn hidden in its column at the seat it will
    // take, and the live card's own report is the measure; the reveal is a
    // later commit that clears the mark and writes the bid from that report
    // ([B04]). A caller that binds the card in the same gesture (`opening:
    // "bound"`: a resume, a command run in a new session) never shows the
    // form, so the card lands visible at its ordinary policy. So does a host
    // with no window: there is no sheet to lay out and nothing to wait for,
    // and a mark made there would stand forever ([L31]).
    const arrivesHidden =
      options?.opening !== "bound" &&
      registration.openingForm !== undefined &&
      typeof window !== "undefined";
    const arriving = arrivesHidden
      ? arrivingWith(this.deckState.arriving, paneId, true)
      : this.deckState.arriving;

    // Single-commit flip (transition 4). `_flipFirstResponder` reads
    // `oldFR` internally BEFORE running the commit, so it fires the
    // correct deactivate pair even though the commit puts
    // `activePaneId = paneId` (which would make a post-commit
    // state-derived read return `firstCardId`).
    const commit = () => {
      // An arrival into a WALL folds the sitters in this same commit, so the
      // wall keeps its one open card ([P06]) — the fold an unfold into a wall
      // already makes, owed equally by a card that arrives there.
      const arrived = opening?.wall
        ? panesWithWallFolded(
            [...this.deckState.panes, win],
            paneId,
            [...opening.members, paneId],
          )
        : [...this.deckState.panes, win];
      this.deckState = {
        ...this.deckState,
        cards: [...this.deckState.cards, ...seededCards],
        panes: arrived,
        activePaneId: paneId,
        // A new card opening into a split column is seated at its BOTTOM,
        // in this same commit ([D194]): the column's order names it from
        // the pane's first frame, so where a new card appears is a rule
        // rather than the fallback's reading of two uuids. A card arriving
        // VISIBLE is weighted here too, so what it takes of the run is a
        // rule as well ([B05]); a card arriving hidden is not yet a member
        // of the division, and its weight is written at the reveal.
        imposition:
          win.slot === undefined
            ? this.deckState.imposition
            : this._impositionSeating(
                this.deckState.imposition,
                arrived,
                paneId,
                win.slot,
                undefined,
                { arriving },
              ),
        ...(arriving !== undefined ? { arriving } : {}),
      };
      this.notify("addCard");
      if (arrivesHidden) {
        tugDevLogStore.debug("arrival", "hidden commit", {
          paneId,
          cardId: firstCardId,
          slot: win.slot ?? null,
          kind: this.deckState.imposition.kind ?? null,
        });
      }
      this.scheduleSave();
      // The card is on the deck but its frame has not finished arriving,
      // and anything that wants to act on a card that has stopped moving
      // — the reveal below, the picker a Session card raises — waits on
      // this mark. A card arriving HIDDEN is not arriving in the settle's
      // sense until its reveal commit, which makes the mark then.
      //
      // Guarded on a window because the clearing half lives in the
      // canvas's settle: a manager driven with no DOM has no canvas, so a
      // mark made here would stand forever and every `onceCardDidArrive`
      // for the card would defer rather than answering at once.
      if (!arrivesHidden && typeof window !== "undefined") {
        this.cardLifecycle.notifyCardWillArrive(firstCardId);
      }
      for (const c of seededCards) {
        this.cardLifecycle.notifyCardDidFinishConstruction(c.id);
      }
      this.putFocusedCardIdGuarded(firstCardId);
    };
    this._flipFirstResponder(firstCardId, commit, "addCard");

    // The card has landed; now the deck goes to it. An opener that names a
    // slot — a file link naming the one beside the card that cited it — can
    // name a slot the band is not showing, and without a reveal the card
    // arrives half under a rail, or off the end of the strip entirely, with
    // nothing but its flash to say where it went.
    //
    // TWO MOVES, NOT ONE. Opening is one act and travelling to what was
    // opened is another, and the deck performs them in that order, with a
    // beat between, rather than arriving pre-scrolled: the reader watches
    // the file open, and then watches the deck go to it.
    //
    // A card arriving hidden takes both moves from its reveal commit, which
    // is the arrival the reader watches ([B04]); here it opens its watch.
    if (arrivesHidden) {
      this._watchArrival(
        paneId,
        firstCardId,
        registration.arrivalQuiet?.(firstCardId) ?? null,
      );
    } else {
      this._revealAfterArrival(firstCardId);
    }

    return firstCardId;
  }

  /**
   * Stand a watch over `paneId`, which arrived hidden, and make its reveal
   * commit when {@link arrivalRevealDue} says so ([B03]).
   *
   * Three sources feed the decision, and each re-asks it: the sheet's own
   * height report for the member, which {@link setSheetReservation} routes
   * here when the member is arriving; the card type's `quiet` source, which
   * fires whenever its answer may have changed; and the bound, one timer
   * armed at the hidden commit. The decision is re-derived from the store on
   * every fire rather than accumulated, so nothing here can disagree with the
   * record: a mark that is gone — the card closed or its pane torn down
   * before the reveal, which {@link sweptArriving} drops at the next commit —
   * ends the watch with no commit.
   *
   * A `null` quiet source is a card with nothing to wait on ([B03]): quiet
   * from the first ask, so the first height report reveals it.
   */
  private _watchArrival(
    paneId: string,
    cardId: string,
    quiet: ArrivalQuiet | null,
  ): void {
    let boundElapsed = false;
    let disposed = false;
    const disposers: Array<() => void> = [];
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      for (const d of disposers) d();
      this.arrivalWatches.delete(paneId);
    };
    const decide = (): void => {
      if (disposed || this.destroyed) return;
      if (this.deckState.arriving?.[paneId] !== true) {
        dispose();
        return;
      }
      const due = arrivalRevealDue({
        reported: this.deckState.sheetReservations?.[paneId] !== undefined,
        quiet: quiet?.isQuiet() ?? true,
        boundElapsed,
      });
      if (!due) return;
      dispose();
      this._revealArrival(paneId, cardId);
    };
    this.arrivalWatches.set(paneId, { decide, dispose });
    if (quiet !== null) disposers.push(quiet.subscribe(decide));
    if (typeof window !== "undefined") {
      const timer = window.setTimeout(() => {
        boundElapsed = true;
        decide();
      }, ARRIVAL_REVEAL_BOUND_MS);
      disposers.push(() => window.clearTimeout(timer));
    }
  }

  /**
   * The REVEAL commit for a pane that arrived hidden ([B04]): one commit that
   * clears the arriving mark, writes the opening bid from the sheet's last
   * hidden report, seats the newcomer's weight in its column, and slides the
   * column's strip if the newcomer overflows it — so the settle it arms
   * carries `room` for the neighbours, the strip's travel, and `arrive` for
   * the card, fused as one motion.
   *
   * The bid is the sheet's most recent reservation while hidden, already a
   * member floor through `memberFloorForSheetPanel`, and it is CURRENT by
   * construction: the quiet source fires from the picker's own layout effect
   * after it has drawn, and that same effect has the sheet re-measure first
   * (`notifySheetContentChanged`), so by the time this runs the report is a
   * reading of the rows the user is about to see rather than of the
   * placeholder they replaced ([L04]'s ready callback, and the reason no
   * timer and no DOM read stand between the store and this commit). The
   * report bit is spent here so the NEXT live report takes the ordinary
   * supersede rule — every frame after the reveal is an honest reservation
   * from a panel that genuinely changed ([B05]). A pane that never reported
   * — the bound expired first — reveals at its policy floor, and its first
   * live report adjusts it as on any card.
   *
   * The lifecycle mark and the deck's travel to the card are made from here
   * rather than from the hidden commit, because this is the arrival the
   * settle plays and the reader watches.
   */
  private _revealArrival(paneId: string, cardId: string): void {
    if (this.destroyed) return;
    const pane = this.deckState.panes.find((p) => p.id === paneId);
    if (pane === undefined || this.deckState.arriving?.[paneId] !== true) {
      return;
    }
    const arriving = arrivingWith(this.deckState.arriving, paneId, false);
    const report = this.deckState.sheetReservations?.[paneId];
    tugDevLogStore.debug("arrival", "reveal commit", {
      paneId,
      cardId,
      bid: report ?? null,
    });
    const openingBids =
      report === undefined
        ? this.deckState.openingBids
        : openingBidsWith(this.deckState.openingBids, paneId, report);
    const { arriving: _cleared, ...rest } = this.deckState;
    const revealed: DeckState = {
      ...rest,
      ...(arriving !== undefined ? { arriving } : {}),
      ...(openingBids !== undefined ? { openingBids } : {}),
    };
    this.deckState = {
      ...revealed,
      imposition:
        pane.slot === undefined
          ? revealed.imposition
          : this._impositionSeating(
              revealed.imposition,
              revealed.panes,
              paneId,
              pane.slot,
              undefined,
              { openingBids, arriving },
              true,
            ),
    };
    // The column's scroll is a term of THIS commit, not a later one. A
    // newcomer whose floor does not fit beside its sitters overflows the
    // column into a strip, and the strip has to slide to show the card
    // whole; written here, that slide rides the room beat with the sitters'
    // shrink, so the settle plays room, arrive, and the column's travel as
    // one motion. Left for `_revealAfterArrival`, it was its own commit a beat
    // after the card had landed — the deck's "TWO MOVES" rule, written for a
    // file link opening a card in a slot the band is not showing, and read
    // here as a third motion on every arrival that overflows. The deferred
    // reveal still runs, and finds nothing left to move.
    this.deckState = {
      ...this.deckState,
      ...this._revealTerms(paneId, this.deckState.panes),
    };
    if (report !== undefined) {
      noteOpeningBidMember(cardId, paneId);
      openingBidReportedFor(paneId);
    }
    if (typeof window !== "undefined") {
      this.cardLifecycle.notifyCardWillArrive(cardId);
    }
    this.notify("revealArrival");
    this._revealAfterArrival(cardId);
  }

  /**
   * Show a card type as a singleton: if any card with `componentId`
   * already exists in the deck, activate it — `activateCard` raises its
   * host pane to z-top — instead of creating a duplicate. Otherwise
   * fall through to {@link addCard}.
   *
   * Singleton-ness is a property of this call site, not of the card
   * registry: callers that want multiple instances keep using
   * `addCard` directly.
   *
   * Returns the reused or newly created card id, or `null` when
   * `componentId` is unregistered (same contract as `addCard`).
   */
  showSingletonCard(componentId: string): string | null {
    const existing = this.deckState.cards.find(
      (c) => c.componentId === componentId,
    );
    if (existing) {
      if (getRegistration(componentId)?.placement === "center") {
        this.centerPane(existing.id);
      }
      this.activateCard(existing.id);
      return existing.id;
    }
    return this.addCard(componentId);
  }

  /**
   * Re-center the pane hosting `cardId` in the live canvas, at the size it
   * already carries.
   *
   * A dialog-like card (registration `placement: "center"`) takes this on
   * every show, not only at creation. The card is a singleton that survives in
   * the layout blob, so a position saved from an older arrangement outlives
   * that arrangement — and the middle of the canvas is the one place the
   * pinned rail can never be standing.
   *
   * A pane whose geometry is DERIVED is left alone: a slotted pane is placed
   * by the imposer and a rail by its pin, so writing a stored position for
   * either would be writing a number nothing reads.
   */
  centerPane(cardId: string): void {
    const pane = this.deckState.panes.find((p) => p.cardIds.includes(cardId));
    if (pane === undefined) return;
    if (pane.slot !== undefined) return;
    if (findSidebarPanes(this.deckState).some(({ pane: p }) => p.id === pane.id)) {
      return;
    }
    const canvasWidth = this.container.clientWidth || 800;
    const canvasHeight = this.container.clientHeight || 600;
    const x = Math.max(0, Math.floor((canvasWidth - pane.size.width) / 2));
    const y = Math.max(0, Math.floor((canvasHeight - pane.size.height) / 2));
    if (pane.position.x === x && pane.position.y === y) return;
    this.deckState = {
      ...this.deckState,
      panes: this.deckState.panes.map((p) =>
        p.id === pane.id ? { ...p, position: { x, y } } : p,
      ),
    };
    this.notify("centerPane");
    this.scheduleSave();
  }

  /**
   * Show a sidebar card: if it already exists, raise/activate it; otherwise
   * create its pinned rail pane at the width it reopens at. The pinned
   * analogue of {@link showSingletonCard}/{@link addCard} (which only make
   * free panes). Returns the card id, or `null` if the card type is
   * unregistered.
   */
  showSidebarPane(componentId: string): string | null {
    // Asking for a sidebar settles the factory deck's held-back rail.
    this.factoryRailPending = false;
    const existing = this.deckState.cards.find(
      (c) => c.componentId === componentId,
    );
    if (existing) {
      // A parked card is unparked by the activation (`activateCard`).
      this.activateCard(existing.id);
      return existing.id;
    }
    return this._createSidebarPane(componentId);
  }

  /**
   * Hide a sidebar card by closing its pane. It tests presence, so a parked
   * card — on the deck, its rail hidden whole — is closed too. No-op when the
   * card is not on the deck.
   */
  hideSidebarPane(componentId: string): void {
    // Dismissing a sidebar settles the factory rail too — the factory default
    // must not reinstate what the user just closed.
    this.factoryRailPending = false;
    const card = this.deckState.cards.find(
      (c) => c.componentId === componentId,
    );
    if (!card) return;
    const pane = this.deckState.panes.find((p) => p.cardIds.includes(card.id));
    if (pane) this.handlePaneClosed(pane.id);
  }

  /**
   * Show `side`'s rail: unpark the members it held when it was last hidden
   * whole, or — with no such memory — open the one card that belongs there.
   * Returns the card id of the member left z-frontmost, or `null` when the
   * side has nothing to show.
   *
   * A hide parks its members ({@link hideSidebarRail}), so the members a
   * memory names are still on the deck, mounted, and showing them is clearing
   * the memory: ONE reimpose, nothing minted, so the show beat moves a layer
   * that already stands. A remembered member that is no longer present — a
   * deck saved before parking, or a member closed while parked — is reopened
   * as before.
   *
   * The memory is z-ordered, back to front ({@link RailArrangement.hidden}),
   * so the member that was in front when the rail went away is in front when
   * it comes back. Vertical order lives in the side's `order` and survives the
   * round trip untouched.
   */
  showSidebarRail(side: SidebarSide): string | null {
    const remembered = railHiddenMembers(
      this.deckState.imposition,
      side,
    ).filter((componentId) => isSidebarCard(componentId));
    if (remembered.length === 0) {
      let frontmost: string | null = null;
      for (const componentId of this._defaultRailMembers(side)) {
        const cardId = this.showSidebarPane(componentId);
        if (cardId !== null) frontmost = cardId;
      }
      return frontmost;
    }
    const cardOf = (componentId: string): string | undefined =>
      this.deckState.cards.find((c) => c.componentId === componentId)?.id;
    const absent = remembered.filter((componentId) => cardOf(componentId) === undefined);
    this._reimpose(withRailHidden(this.deckState.imposition, side, []));
    for (const componentId of absent) this.showSidebarPane(componentId);
    let frontmost: string | null = null;
    for (const componentId of remembered) frontmost = cardOf(componentId) ?? frontmost;
    return frontmost;
  }

  /**
   * Hide `side`'s rail: PARK its members. The memory names them, and that is
   * the whole of the hide: their panes and cards stay in the deck, mounted,
   * and the imposer seats none of them, so the band's insets are as if the
   * rail were absent. The canvas keeps each frame at its pinned box, hidden
   * and inert ([L23]'s third class, as for a parked workspace), and its loops
   * pause. A show clears the memory and the same frames stand again.
   *
   * The keyboard leaves first, the way a close hands it on: if the first
   * responder or the active pane is a member, it goes to the card the close
   * successor names, reckoned while the rail still stands.
   */
  hideSidebarRail(side: SidebarSide): void {
    const members = railMembersToPark(this.deckState, side);
    if (members.length === 0) return;
    // Hiding a sidebar settles the factory rail, as closing one did.
    this.factoryRailPending = false;
    this._handOnFromParking(side);
    this._reimpose(withRailHidden(this.deckState.imposition, side, members));
  }

  /**
   * Move the keyboard off `side`'s seated members before they park, the way
   * {@link _closePane} moves it off a closing pane: to the close successor of
   * the member holding it, never to another member being parked, and to
   * nobody when only rail cards stand.
   */
  private _handOnFromParking(side: SidebarSide): void {
    const imposition = this.deckState.imposition;
    const parking = new Set(
      findSidebarPanes(this.deckState)
        .filter(
          ({ componentId }) =>
            isSidebarSeated(imposition, componentId) &&
            sidebarSide(imposition, componentId) === side,
        )
        .map(({ pane }) => pane.id),
    );
    const activePaneId = this.deckState.activePaneId;
    if (activePaneId === undefined || !parking.has(activePaneId)) return;
    const currentFR = this.getFirstResponderCardId();
    const successor = this._closeSuccessorCardId(activePaneId);
    const host =
      successor === null
        ? undefined
        : this.deckState.panes.find(
            (p) => !parking.has(p.id) && p.cardIds.includes(successor),
          );
    const newFR = host === undefined ? null : successor;
    const flipCommit = (): void => {
      this.deckState = {
        ...this.deckState,
        ...(host !== undefined && newFR !== null
          ? {
              panes: this.deckState.panes.map((p) =>
                p.id === host.id ? { ...p, activeCardId: newFR } : p,
              ),
            }
          : {}),
        activePaneId: host?.id,
      };
      this.notify("hideSidebarRail");
      this.scheduleSave();
      if (newFR !== null) this.putFocusedCardIdGuarded(newFR);
    };
    if (newFR !== null) {
      transferFocusForActivation({
        outgoingCardId: currentFR,
        incomingCardId: newFR,
        store: this,
        commitMutation: () => {
          this._flipFirstResponder(newFR, flipCommit, "hideSidebarRail");
        },
      });
    } else {
      this._flipFirstResponder(newFR, flipCommit, "hideSidebarRail");
    }
  }

  /** Clear the hidden memory of the side `cardId` is parked on, if it is. */
  private _unparkCard(cardId: string): void {
    const card = this.deckState.cards.find((c) => c.id === cardId);
    if (card === undefined || !isSidebarParked(this.deckState, card.componentId)) return;
    const side = sidebarSide(this.deckState.imposition, card.componentId);
    this._reimpose(withRailHidden(this.deckState.imposition, side, []));
  }

  /**
   * What showing a rail opens when nothing remembers what it held: the one
   * sidebar card that belongs on `side`, named by the side's stored order if
   * it names one and by registration order otherwise.
   *
   * One card rather than every card assigned to the side. A rail nobody has
   * hidden whole is a rail whose members the user closed one at a time, and
   * reopening the pile they dismissed card by card would be answering a
   * gesture they did not make.
   */
  private _defaultRailMembers(side: SidebarSide): readonly string[] {
    const imposition = this.deckState.imposition;
    const belongs = [...getAllRegistrations().keys()].filter(
      (componentId) =>
        isSidebarCard(componentId) &&
        sidebarSide(imposition, componentId) === side,
    );
    if (belongs.length === 0) return [];
    const named = (imposition.rails?.[side]?.order ?? []).find((componentId) =>
      belongs.includes(componentId),
    );
    return [named ?? belongs[0]];
  }

  /**
   * Set the side of the deck a sidebar card holds.
   *
   * A sidebar's side is one axis of the deck's imposition, so this writes its
   * entry in `imposition.sidebars`. Moving one rail moves the band's edge, so
   * every slotted pane moves along with it — the ledger below covers them all,
   * not just the sidebar named.
   *
   * Choosing a side also RE-PINS a sidebar that had been dragged loose: naming
   * the side a card holds is the gesture that says it holds one. This is why the
   * call is not short-circuited on an unchanged side — picking "right" while a
   * floating rail already records "right" is a request to put it back.
   */
  setSidebarSide(componentId: string, side: SidebarSide): void {
    const imposition = this.deckState.imposition;
    if (
      sidebarSide(imposition, componentId) === side &&
      isSidebarPinned(imposition, componentId)
    ) {
      return;
    }
    this._reimpose(withSidebarSide(imposition, componentId, side));
  }

  /**
   * The sidebar componentIds standing on `side`, top to bottom.
   *
   * Sorted into REGISTRATION order before the imposition's stored order is
   * applied, which is the contract `effectiveRailOrder` states and cannot
   * enforce: the list every deck reading reaches for — `findSidebarPanes` —
   * walks `state.panes`, the array `activateCard` reorders. Handing that in
   * would make a rail with no stored order follow the last raise.
   */
  private _railOrder(
    imposition: DeckImposition,
    side: SidebarSide,
    panes?: readonly TugPaneState[],
  ): readonly string[] {
    const state =
      panes === undefined ? this.deckState : { ...this.deckState, panes };
    const standing = new Set(
      findSidebarPanes(state)
        .filter(({ componentId }) => isSidebarSeated(imposition, componentId))
        .map(({ componentId }) => componentId),
    );
    const registered = [...getAllRegistrations().keys()].filter((componentId) =>
      standing.has(componentId),
    );
    return effectiveRailOrder(imposition, side, registered);
  }

  /**
   * Put `side`'s members in `order`, top to bottom — the corridor drag's
   * commit. Filtered to sidebar componentIds, so a caller cannot record a
   * content card's id as a member of a rail.
   *
   * Ids the rail does not currently hold are kept: a closed member's place is
   * part of the arrangement, and dropping it here would lose that place on the
   * first reorder made while it was closed ([P06]).
   */
  setRailOrder(side: SidebarSide, order: readonly string[]): void {
    const members = order.filter((componentId) => isSidebarCard(componentId));
    const current = this.deckState.imposition.rails?.[side]?.order;
    if (current !== undefined && current.length === members.length) {
      if (current.every((id, i) => id === members[i])) return;
    }
    this._reimpose(withRailOrder(this.deckState.imposition, side, members));
  }

  /**
   * Land `componentId` at position `index` of `side`'s rail, from whichever
   * rail it stands on — the cross-side drop's commit. One `_reimpose`
   * carrying the side and both rails' orders: a second commit would arm a
   * second settle under the same gesture, and `setSidebarSide` alone would
   * append the card at the side's
   * default position and tween it there before the order moved it again.
   */
  moveSidebarToRail(componentId: string, side: SidebarSide, index: number): void {
    if (!isSidebarCard(componentId)) return;
    const imposition = this.deckState.imposition;
    this._reimpose(
      withSidebarMovedToRail(imposition, componentId, side, index, {
        left: this._railOrder(imposition, "left"),
        right: this._railOrder(imposition, "right"),
      }),
    );
  }

  /**
   * Set `side`'s height weights — the seam drag's commit. Weights that are not
   * finite non-negative numbers are dropped rather than stored: an unnamed
   * member already weighs 1, so a dropped weight means exactly what a missing
   * one does, and nothing downstream has to defend against a `NaN` height.
   *
   * ZERO IS A SHARE. A share divides the RUN, bounded below by every member's
   * floor ([P04]), and a member dragged down to its floor took no share of
   * the run — the honest record of which is `0`, not the `1` a dropped weight
   * would mean. Only negatives and non-numbers are refusals.
   */
  setRailShares(side: SidebarSide, shares: Record<string, number>): void {
    const weights: Record<string, number> = {};
    for (const [componentId, weight] of Object.entries(shares)) {
      if (!isSidebarCard(componentId)) continue;
      if (typeof weight !== "number") continue;
      if (!Number.isFinite(weight) || weight < 0) continue;
      weights[componentId] = weight;
    }
    this._reimpose(withRailShares(this.deckState.imposition, side, weights));
  }

  /**
   * *Resize Sidebars to Fit* — the one algorithm left on a rail, and the user
   * is the only thing that runs it ([B07]).
   *
   * Each rail with members is stood at [B08]'s division of its run: every
   * card at the height its content asks for, read from the DOM at this
   * moment, with whatever the run has over or under that shared out in
   * proportion. The answer goes in through `placeSharesFromHeights` and
   * `setRailShares`, which is exactly the path a seam drag's release takes —
   * so from the release onward the division is the hand's, and nothing
   * re-runs this: not a resize, not a content change, not a member leaving,
   * not a relaunch.
   *
   * A rail whose card cannot be read — no pane on the rail yet, no content
   * element in it — contributes its floor and takes its share of the room
   * from there, which is the honest answer for a card with nothing to show
   * rather than a reason to refuse the whole verb.
   */
  resizeSidebarsToFit(): void {
    const run = this.getRailRunHeight();
    if (run === null) return;
    for (const side of ["left", "right"] as const) {
      const state = this.deckState;
      const componentIds = railMembersOf(state, side).map(
        (member) => member.componentId,
      );
      if (componentIds.length < 2) continue;
      const members = placeMembers(
        state,
        "rail",
        componentIds,
        state.imposition.rails?.[side]?.shares,
      );
      const heights = fitHeights(
        members.map((member, i) => ({
          floor: member.floor,
          natural: railNaturalOf(componentIds[i], run) ?? member.floor,
        })),
        run,
        RAIL_SEAM_PX,
      );
      const shares = placeSharesFromHeights(members, heights, run, RAIL_SEAM_PX);
      if (Object.keys(shares).length === 0) continue;
      this.setRailShares(side, shares);
    }
  }

  /**
   * The pane ids standing in `slot`, in the order the slot's column puts them —
   * top to bottom when it is split, and the same list held in reserve when it
   * is stacked.
   *
   * Read through `deckColumnsOf` rather than derived here, because that is the
   * order the deck DRAWS. Two readings of one column would agree only by luck,
   * and the frame they disagreed in is the one where a member is laid out at
   * another member's pins.
   */
  private _columnOrder(slot: number): readonly string[] {
    return columnMembersOf(this.deckState, slot);
  }

  /**
   * Move `paneId` within its column — the move-in-column chords' commit.
   *
   * Returns false when the move is refused, which the caller turns into a
   * visible flash: a pane in no column, a column of one, or a member already
   * at the end it was asked to travel to. A silent false would be a chord that
   * looks broken rather than one that hit an edge.
   *
   * **What "up" means depends on how the column stands, and deliberately so.**
   * Split, the members divide the run and up is up: the chord reorders the
   * stored order and the frames swap pins. Stacked, nothing is above anything
   * — every member draws the same rect — so the only ordering the user can see
   * is z, and up is toward the front. One chord, one meaning per arrangement,
   * and never dead on an unsplit slot ([P12]).
   */
  moveInColumn(paneId: string, where: ColumnMoveTarget): boolean {
    const kind = this.deckState.imposition.kind;
    if (kind === undefined) return false;
    const pane = this.deckState.panes.find((p) => p.id === paneId);
    if (pane?.slot === undefined) return false;
    const slot = clampSlot(kind, pane.slot);
    const split = columnModeOf(this.deckState.imposition, slot) === "split";
    // Split: top-to-bottom, the order the eye reads. Stacked: back-to-front,
    // reversed so index 0 is the front and "up" is one index earlier in both.
    // The same walk the menu's `column` fact reads to say whether this move
    // would be refused.
    const order = [...columnMoveOrder(this.deckState, paneId)];
    if (order.length < 2) return false;
    const from = order.indexOf(paneId);
    if (from === -1) return false;
    const to =
      where === "up"
        ? from - 1
        : where === "down"
          ? from + 1
          : where === "top"
            ? 0
            : order.length - 1;
    if (to === from || to < 0 || to >= order.length) return false;

    if (split) {
      const next = [...order];
      next.splice(from, 1);
      next.splice(to, 0, paneId);
      // Named as the moved member, so an overflowing column slides to show
      // where the card went in the same commit that moved it. Sending a card
      // to the bottom of a five-member column and leaving it below the run
      // would be a move with no visible outcome.
      this.setColumnOrder(slot, next, paneId);
      return true;
    }

    // Stacked, and therefore a z move. Reaching the FRONT is an activation:
    // bringing a buried card all the way up is asking to look at it, and the
    // focus transfer is what a raise means everywhere else in the deck.
    if (to === 0) {
      const card = pane.activeCardId;
      transferFocusForActivation({
        outgoingCardId: this.getFirstResponderCardId(),
        incomingCardId: card,
        store: this,
        commitMutation: () => this.activateCard(card),
        deferCommit: mayDeferCommit(this, card),
      });
      return true;
    }
    // Every other z move is a reorder and nothing else: `sendPaneBehind` puts
    // one pane immediately below another, which expresses both directions —
    // promoting past the neighbour in front is that neighbour dropping behind
    // this one.
    this.sendPaneBehind(
      where === "up" ? order[to] : paneId,
      where === "up" ? paneId : order[to],
    );
    return true;
  }

  /**
   * Stack or split `slot`'s column, reached from the stack badge, the Layout
   * card, and ⌃⌘/.
   *
   * Splitting materializes the slot's `order` in the same imposition for the
   * same reason a rail does: a split column's vertical order is stored state
   * from the first frame rather than a fallback a later raise could move. One
   * commit carrying both fields arms exactly one settle.
   *
   * Re-stacking keeps order and shares, so a re-split lands where the user left
   * it rather than on a default.
   */
  setColumnMode(slot: number, mode: ColumnMode): void {
    const imposition = this.deckState.imposition;
    if (columnModeOf(imposition, slot) === mode) return;
    const next = withColumnMode(imposition, slot, mode);
    this._reimpose(
      mode === "split"
        ? withColumnOrder(next, slot, this._columnOrder(slot))
        : next,
    );
  }


  /**
   * Put `slot`'s members in `order`, top to bottom — what a corridor drag and
   * the move-in-column chords commit.
   *
   * Filtered to panes that actually stand in `slot`, so a caller cannot record
   * a pane from another slot, a free pane, or a rail as a member of a column.
   * Unlike {@link setRailOrder}, ids the column does not currently hold are
   * *dropped* rather than kept: a rail member's place survives its card being
   * closed because a rail is keyed by card type, and a column is keyed by pane
   * id, which nothing will ever bring back. Keeping them would grow the record
   * forever to preserve places no member can return to.
   */
  setColumnOrder(
    slot: number,
    order: readonly string[],
    movedPaneId?: string,
  ): void {
    const standing = new Set(
      this.deckState.panes.filter((p) => p.slot === slot).map((p) => p.id),
    );
    const members = order.filter((paneId) => standing.has(paneId));
    const current = this.deckState.imposition.columns?.[slot]?.order;
    if (current !== undefined && current.length === members.length) {
      if (current.every((id, i) => id === members[i])) return;
    }
    this._reimpose(
      withColumnOrder(this.deckState.imposition, slot, members),
      movedPaneId,
    );
  }

  /**
   * Set `slot`'s height weights — the column seam drag's commit. Weights that
   * are not finite non-negative numbers are dropped rather than stored,
   * exactly as {@link setRailShares} drops them — zero included as a weight,
   * for {@link setRailShares}'s own reason.
   */
  setColumnShares(slot: number, shares: Record<string, number>): void {
    const standing = new Set(
      this.deckState.panes.filter((p) => p.slot === slot).map((p) => p.id),
    );
    const weights: Record<string, number> = {};
    for (const [paneId, weight] of Object.entries(shares)) {
      if (!standing.has(paneId)) continue;
      if (typeof weight !== "number") continue;
      if (!Number.isFinite(weight) || weight < 0) continue;
      weights[paneId] = weight;
    }
    this._reimpose(withColumnShares(this.deckState.imposition, slot, weights));
  }

  /** Divide `slot`'s run equally again — what the badge's "Equalize Heights"
   *  asks for. It WRITES the equal division, one share apiece for every member
   *  standing, rather than dropping the record: an absent record and an
   *  all-ones one allocate alike, and equalize is a hand's division like any
   *  drag, which means it outlives the next membership change ([B04]). */
  equalizeColumn(slot: number): void {
    const imposition = this.deckState.imposition;
    const members = columnMembersOf(this.deckState, slot);
    if (members.length < 2) return;
    this._reimpose(
      withColumnShares(
        imposition,
        slot,
        Object.fromEntries(members.map((paneId) => [paneId, 1])),
      ),
    );
  }

  /**
   * Return every rail to its pin without changing which side it holds. What
   * the kind rows ask for: choosing an arrangement is choosing one the rails
   * are part of. No-op when they all already stand pinned.
   */
  pinSidebars(): void {
    const pinned = this._withSidebarsPinned(this.deckState.imposition);
    if (pinned === this.deckState.imposition) return;
    this._reimpose(pinned);
  }

  /**
   * `imposition` with every sidebar card that has been dragged off its pin put
   * back on it, side unchanged — and the SAME object when none has been, so a
   * caller can tell "nothing to do" by identity rather than by re-deriving it.
   *
   * It walks the `sidebars` map rather than the open panes because a card the
   * user dragged loose and then closed still carries `pinned: false`, and the
   * arrangement it reopens into is the one the map records.
   */
  private _withSidebarsPinned(imposition: DeckImposition): DeckImposition {
    const loose = Object.keys(imposition.sidebars ?? {}).filter(
      (componentId) => !isSidebarPinned(imposition, componentId),
    );
    if (loose.length === 0) return imposition;
    return loose.reduce(
      (acc, componentId) => withSidebarPinned(acc, componentId, true),
      imposition,
    );
  }

  /**
   * The pinned sidebar panes standing on each side, with the side's rail
   * policy — the width the user chose for it, the two floors beneath it, and
   * how greedy it is for the width the deck has to share out.
   *
   * Same-side cards share ONE rail, so the side's policy folds its members:
   * the preferred width is the widest chosen width (a rail must be able to show
   * the card its owner sized widest), each floor — the hard one below which a
   * card cannot paint, and the comfort one below which it is merely uncomfy —
   * is the tightest member's (a rail is one width, so any member's floor binds
   * it), and the greed rank is the GREEDIEST member's — a rail carrying a prose
   * reader is a prose reader's rail wherever it stands, whatever modest card is
   * stacked behind it.
   *
   * The rail's own standing width is deliberately not folded in, and not
   * carried at all: the allocator answers from the canvas, the chain, and these
   * policies, so it cannot read its own past answers back as an input.
   */
  private _sidebarRails(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): {
    rails: { left?: RailPolicy; right?: RailPolicy };
    panesBySide: Map<SidebarSide, TugPaneState[]>;
  } {
    const rails: { left?: RailPolicy; right?: RailPolicy } = {};
    const panesBySide = new Map<SidebarSide, TugPaneState[]>();
    const state = { ...this.deckState, panes: [...panes] };
    for (const { componentId, pane } of findSidebarPanes(state)) {
      if (!isSidebarSeated(imposition, componentId)) continue;
      const side = sidebarSide(imposition, componentId);
      const held = panesBySide.get(side) ?? [];
      held.push(pane);
      panesBySide.set(side, held);
      const policy: RailPolicy = {
        preferredWidth: this._sidebarPreferredWidth(componentId),
        minWidth: getSizePolicy(componentId).min.width,
        comfortWidth: getComfortWidth(componentId),
        greedRank: getGreedRank(componentId),
      };
      const standing = rails[side];
      rails[side] =
        standing === undefined
          ? policy
          : {
              preferredWidth: Math.max(
                standing.preferredWidth,
                policy.preferredWidth,
              ),
              minWidth: Math.max(standing.minWidth, policy.minWidth),
              comfortWidth: Math.max(
                standing.comfortWidth,
                policy.comfortWidth,
              ),
              greedRank: Math.min(standing.greedRank, policy.greedRank),
            };
    }
    return { rails, panesBySide };
  }

  /**
   * The width the user last chose for a sidebar card — the width its rail
   * fills toward and drains away from, and the width it snaps to when there is
   * no chain to fit. Read from the card's DURABLE store
   * ({@link sidebarWidthStore}), never from the live
   * pane: the live width is where the allocator writes its own answers, and an
   * allocator that reads its output back as the user's preference re-anchors on
   * every solve and keeps every past grant — the ratchet that let one rail
   * quietly absorb the deck's slack. A card the user has never sized anchors on
   * its registered preferred width.
   */
  private _sidebarPreferredWidth(componentId: string): number {
    return (
      sidebarWidthStore.widthFor(componentId) ??
      getSizePolicy(componentId).preferred.width
    );
  }

  /**
   * The width each pinned sidebar rail should stand at for a given
   * arrangement — the space allocator's answer, keyed by side — or `null` when
   * the allocator does not apply.
   *
   * It does not apply unless a sidebar card is open, pinned, and there is an
   * arrangement for it to stand at the end of: a floating or closed sidebar is
   * not the band's other end, and with no kind there is no chain to tile. Those
   * are the `null`s — the allocator itself is a total function and answers for
   * every rail that stands, so "the answer is the widths already showing" is a
   * comparison the callers make, never a refusal the solver returns.
   *
   * The widths handed to the solver are RENDER widths, raised to each stack's
   * size floor exactly as `TugPane` and `DeckCanvas` raise them. A chain solved
   * on stored widths below the floor would tile a picture the deck never paints.
   */
  private _allocatedRailWidths(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): RailWidths | null {
    const kind = imposition.kind;
    if (kind === undefined) return null;
    const { rails } = this._sidebarRails(panes, imposition);
    if (rails.left === undefined && rails.right === undefined) return null;
    const canvasWidth = this.container.clientWidth;
    if (!canvasWidth) return null;

    const cardsById = new Map<string, CardState>();
    for (const card of this.deckState.cards) cardsById.set(card.id, card);
    const renderWidth = (pane: TugPaneState): number =>
      Math.max(
        pane.size.width,
        getStackSizePolicy(
          pane.cardIds
            .map((cid) => cardsById.get(cid)?.componentId)
            .filter((cid): cid is string => cid !== undefined),
        ).min.width,
      );

    const occupied = panes
      .filter((pane) => pane.slot !== undefined)
      .map((pane) => ({ slot: pane.slot as number, width: renderWidth(pane) }));

    // A rail may grow to the SLIM content width and no further, whatever
    // Card Width the deck is set to. A rail is a reading surface; a comfy- or
    // wide-sized sidebar is absurd on its face, so the ceiling does not follow
    // the preset.
    return allocateSidebarWidths({
      canvasWidth,
      kind,
      layout: imposition.layout,
      occupied,
      // What an empty slot holds open, so the width the objective scores is
      // the width the deck paints. Flow keeps every slot of the kind standing
      // (`deckFlowStrip`); an allocator scoring the occupied run alone would
      // be measuring a strip nobody sees. Derived from the chain in hand rather
      // than from `this.deckState`, because this solve may be running against a
      // pending set of panes.
      emptyExtent: vacancyExtent(
        occupied,
        resolveContentWidthPx(
          imposition.contentWidth ?? DEFAULT_CONTENT_WIDTH,
          0,
        ),
      ),
      rails,
      maxRailWidth: CONTENT_WIDTH_SLIM_PX,
    });
  }

  /**
   * The panes the space allocator would commit for this arrangement — every
   * sidebar pane whose solved width differs from the one it is showing, with
   * that width written in — and the same array back when nothing moves.
   *
   * The solve with no commit and no notify, so the one caller that cannot
   * spend a notify can still have the answer: `activateSpace` re-solves the
   * incoming deck inside its own swap commit ([P04]), because a parked deck
   * carries the arrangement it was solved for at the last switch away and the
   * canvas may have been resized while it was off screen.
   */
  private _railSolvedPanes(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): readonly TugPaneState[] {
    const { panesBySide } = this._sidebarRails(panes, imposition);
    const allocated = this._allocatedRailWidths(panes, imposition);
    if (allocated === null) return panes;
    const widthByPaneId = new Map<string, number>();
    for (const [side, sidePanes] of panesBySide) {
      const width = allocated[side];
      if (width === undefined) continue;
      for (const pane of sidePanes) {
        if (Math.abs(width - pane.size.width) >= 1) {
          widthByPaneId.set(pane.id, width);
        }
      }
    }
    if (widthByPaneId.size === 0) return panes;
    return panes.map((pane) => {
      const width = widthByPaneId.get(pane.id);
      return width === undefined
        ? pane
        : { ...pane, size: { ...pane.size, width } };
    });
  }

  /**
   * Commit an imposition record and the panes it derives geometry for,
   * bracketing both with the lifecycle ledger. Every slotted pane's frame moves
   * — the imposition record is what places them — and the sidebars move with
   * them, so the ledger is built from the fact of the chain rather than from a
   * diff of stored positions, which imposition never writes.
   *
   * The space allocator runs here, on the panes and imposition being committed
   * rather than on the ones being replaced, so a kind change is solved against
   * the arrangement it is turning into. Its answer is written into each sidebar
   * pane's `size.width` — the live width — and deliberately NOT through
   * `movePane`, whose reopen-width mirror is what makes a rail's stored width
   * mean "the width the user chose". An allocation routed through that mirror
   * would quietly overwrite the preference it is supposed to flex around.
   *
   * Every pane sharing a side takes that side's one width: a rail is one width
   * whoever stands in it. The two SIDES are solved separately, though — a wide
   * reading rail does not drag a list rail wide with it.
   */
  private _commitImposition(
    imposition: DeckImposition,
    panes: readonly TugPaneState[],
    opts?: {
      /**
       * Let the space allocator re-solve the rails in this commit. TRUE for
       * every caller that is one of THE MOMENTS (see
       * {@link retuneSidebarAllocation}) — a Layouts click, a slot assignment,
       * a settled canvas resize. FALSE for a commit that merely wants the
       * one-notify shape: a rail's width is the user's, and a gesture that did
       * not ask the deck to arrange itself may not spend it.
       */
      readonly retuneRails: boolean;
      /**
       * Whose reveal this commit owes, when it is not the active pane's.
       *
       * The reveal rules answer for the pane the gesture was ABOUT, and for
       * almost every caller that is the active one — the gesture raised it, or
       * moved the arrangement under it. A move within a column is the
       * exception: `moveInColumn` can carry a member the Cards card resolved rather
       * than the one holding focus, and it is that member the user just sent
       * somewhere and now wants to see.
       *
       * `null` means this commit owes NOBODY a reveal: the caller is holding
       * the reveal back for a commit of its own, one beat later, so the card
       * crosses first and the strip slides second ({@link movePaneToSlot}).
       */
      readonly revealPaneId?: string | null;
      /**
       * A column reveal this caller worked out for itself, in place of the
       * derived one.
       *
       * There is exactly one: opening a card in a WALL ([P06]). Every other
       * reveal in the deck is minimal — bring the member in if it is out —
       * and `_columnRevealOffsetFor` is that rule. A wall open is not minimal:
       * the opened card is about to grow by hundreds of pixels, so the strip
       * moves whatever anybody does, and the answer is a POSITION (the
       * neighbour above in view) rather than a smallest move. The caller
       * computes it because the caller is the one that knows the commit is a
       * wall open; this only has to prefer it.
       */
      readonly columnReveal?: { slot: number; offset: number };
    },
  ): void {
    const retuneRails = opts?.retuneRails ?? true;
    // Every path that moves a pane between slots arrives here, and most of them
    // hand back the imposition they were given — `assignCardsToSlots` writes the
    // new `slot` onto the pane, and a kind change re-clamps every pane — so this
    // is the one place that can keep the columns record honest without each
    // caller remembering to. A stranded member is not cosmetic: invariant 9
    // refuses it and the deck comes up on the error overlay.
    imposition = sweptColumnOrders(imposition, panes);
    const { panesBySide } = this._sidebarRails(panes, imposition);
    const nextPanes = retuneRails
      ? this._railSolvedPanes(panes, imposition)
      : panes;

    const sidebarPaneIds = new Set(
      [...panesBySide.values()].flat().map((pane) => pane.id),
    );
    const moved = nextPanes
      .filter((pane) => pane.slot !== undefined || sidebarPaneIds.has(pane.id))
      .map((pane) => pane.activeCardId);
    // Every pane whose box actually changes, not only the rails the allocator
    // just re-solved: a caller may hand this a pane list it has already resized
    // (the content-width applier does), and a card that is about to be laid out
    // at a new width is owed its resize bracket either way.
    const sizeById = new Map(
      this.deckState.panes.map((pane) => [pane.id, pane.size]),
    );
    const resized = nextPanes
      .filter((pane) => {
        const was = sizeById.get(pane.id);
        return (
          was !== undefined &&
          (was.width !== pane.size.width || was.height !== pane.size.height)
        );
      })
      .map((pane) => pane.activeCardId);

    // Re-reveal the active card in the same commit, because in flow every one
    // of these gestures can have moved the strip out from under it: a slot
    // move re-sums the run, a width change re-sums it, entering flow builds it
    // for the first time. The rule is minimal and idempotent, so a commit that
    // did not move the active card past the band's edge returns the offset
    // standing and this is nothing. ([P10]; in fit `deckFlowStrip` is null and
    // it is nothing always.)
    const activePaneId =
      opts?.revealPaneId === null
        ? undefined
        : (opts?.revealPaneId ?? this.deckState.activePaneId);
    const flowOffset =
      activePaneId === undefined
        ? undefined
        : this._flowRevealOffsetFor(activePaneId, nextPanes, imposition);
    // The vertical half of the same re-reveal: any of these gestures can have
    // rebuilt the column under the active member — a split, a move, a card
    // leaving the slot — and the rule is minimal and idempotent here too.
    const columnReveal =
      opts?.columnReveal ??
      (activePaneId === undefined
        ? undefined
        : this._columnRevealOffsetFor(activePaneId, nextPanes, imposition));
    // And the rail's half of it, for the same reason over the other kind of
    // place: the two rules answer about disjoint panes, so exactly one of them
    // can be anything but `undefined` on any given commit.
    const railReveal =
      activePaneId === undefined
        ? undefined
        : this._railRevealOffsetFor(activePaneId, nextPanes, imposition);

    for (const cardId of moved) this.cardLifecycle.notifyCardWillMove(cardId);
    for (const cardId of resized) this.cardLifecycle.notifyCardWillResize(cardId);
    this.deckState = {
      ...this.deckState,
      panes: nextPanes,
      imposition,
      ...(flowOffset !== undefined ? { flowOffset } : {}),
      ...this._withColumnReveal(columnReveal),
      ...this._withRailReveal(railReveal),
    };
    this.notify("_commitImposition");
    for (const cardId of resized) this.cardLifecycle.notifyCardDidResize(cardId);
    for (const cardId of moved) this.cardLifecycle.notifyCardDidMove(cardId);
    this.scheduleSave();
  }

  /**
   * Re-solve every pinned sidebar rail's width for the arrangement as it
   * stands, and commit if any of them changed. A no-op when the allocator does
   * not apply or its answer is the widths already showing.
   *
   * THE MOMENTS. A rail's width belongs to the user, and the deck may spend
   * it only when the user has just asked the deck to arrange itself: a click
   * in the Layout card, a card assigned to a slot (`assignCardToSlot` —
   * the imposer's own verb, whether the Cards card's slot picker or a ⌘N chord
   * dispatched it), and a canvas that came to rest at a new size
   * (`deck-canvas.tsx`'s settled-resize observer — the window edge, a display
   * change, a space move). Nothing else re-solves. Dragging a card out of the
   * chain or closing one changes what the chain is and leaves the rails
   * exactly where they stand, because the user was removing a CARD and did
   * not ask for their rail to be resized.
   *
   * This is that second moment; the first commits through
   * {@link _commitImposition} directly. A pick that does not change the kind
   * lands here too — re-asserting the arrangement is a request for the seams,
   * and it is the only way to ask for them without changing anything else.
   */
  retuneSidebarAllocation(): void {
    const imposition = this.deckState.imposition;
    const panes = this.deckState.panes;
    this._retuneFlowOffset(panes, imposition);
    this._retuneColumnOffsets(panes, imposition);
    this._retuneRailOffsets(panes, imposition);
    // [P11]. The run each place was last allocated against, against the run it
    // stands in now. This is read BEFORE the width allocator's own `moves`
    // check and before the `panesBySide.size === 0` return, because a deck
    // whose rails did not move — or which has no rails at all, and only
    // columns — still has to re-derive its columns when the window's height
    // changed. That early return was written when neither answer depended on
    // the run and the pure-CSS resize path was the whole of the story.
    const runs: PlaceRuns = {
      rail: this._placeRunHeight("rail"),
      column: this._placeRunHeight("column"),
    };
    const runMoved = placeRunsMoved(this._lastPlaceRuns, runs);
    this._lastPlaceRuns = runs;
    const { panesBySide } = this._sidebarRails(panes, imposition);
    const allocated =
      panesBySide.size === 0
        ? null
        : this._allocatedRailWidths(panes, imposition);
    const moves =
      allocated !== null &&
      [...panesBySide].some(([side, sidePanes]) => {
        const width = allocated[side];
        return (
          width !== undefined &&
          sidePanes.some((pane) => Math.abs(width - pane.size.width) >= 1)
        );
      });
    if (moves) {
      this._commitImposition(imposition, panes);
      return;
    }
    // Exactly one notify either way: the width commit above already re-derives
    // every allocation, so the run's own commit is the case where no width
    // moved and it carries `retuneRails: false` — there is nothing to re-solve
    // in the widths, only heights to re-allocate.
    if (!runMoved) return;
    this._commitImposition(imposition, panes, { retuneRails: false });
  }

  /**
   * Solve the deck that is about to be shown against the canvas it is about to
   * stand in, writing the answer straight into `deckState` and notifying
   * NOBODY ([P04]).
   *
   * A parked workspace's deck is written by `parkedDeck` at the switch away
   * and is never re-solved while it is off screen: the settled-resize re-tune
   * reads `this.deckState`, which is the ACTIVE workspace's deck, so a window
   * resized while a workspace was parked hands that workspace back an
   * arrangement solved for a canvas that no longer exists. Shown as it stands,
   * the first frame is wrong and the correction arrives a beat later — which
   * is exactly the post-landing movement this arc is removing.
   *
   * So the solve rides the swap commit instead. `activateSpace` calls this
   * between writing `deckState` and its one `notify`, so the first frame any
   * subscriber can draw is already the resized solution and there is nothing
   * left to arm. It is the same arithmetic {@link retuneSidebarAllocation}
   * runs — the width allocator, then the three offset retunes — reached
   * through the `*Terms` forms so the whole of it lands in one write.
   *
   * `_lastPlaceRuns` moves with it, or the next settled-resize re-tune reads a
   * run this solve already answered and commits the work a second time.
   *
   * No lifecycle resize bracket is fired for a pane this widens, and that is
   * deliberate: the bracket is how a card is told to expect motion, and the
   * whole point of doing the solve here is that there is none to expect. The
   * frames arrive at their solved size and a card that measures its own box
   * sees one size, once.
   */
  private _resolveShownArrangement(): void {
    const imposition = this.deckState.imposition;
    const panes = this._railSolvedPanes(this.deckState.panes, imposition);
    this._lastPlaceRuns = {
      rail: this._placeRunHeight("rail"),
      column: this._placeRunHeight("column"),
    };
    this.deckState = { ...this.deckState, panes };
    this.deckState = {
      ...this.deckState,
      ...this._flowRetuneTerms(panes, imposition),
      ...this._columnRetuneTerms(panes, imposition),
      ...this._railRetuneTerms(panes, imposition),
    };
  }

  /**
   * Commit a new imposition record, moving every pane whose geometry it
   * derives. A rail returns to its pin through here, and the space allocator
   * re-solves its width for the arrangement being committed.
   */
  private _reimpose(
    imposition: DeckImposition,
    revealPaneId?: string,
  ): void {
    this._commitImposition(imposition, this.deckState.panes, {
      retuneRails: true,
      ...(revealPaneId !== undefined ? { revealPaneId } : {}),
    });
  }

  /** The sidebar componentId this pane hosts, or `undefined` when it hosts no
   *  sidebar card. */
  private _sidebarComponentIdOfPane(paneId: string): string | undefined {
    return findSidebarPanes(this.deckState).find(
      (entry) => entry.pane.id === paneId,
    )?.componentId;
  }

  /**
   * Release a sidebar from its pin: it becomes an ordinary free pane at
   * `rect`, and the arrangement spans the canvas its rail was taking. Called
   * from the pane's move commit — dragging a sidebar by its title bar is the
   * only way out of the pin, and the Layouts section is the only way back in.
   */
  private _unpinSidebar(
    componentId: string,
    paneId: string,
    rect: { position: { x: number; y: number }; size: { width: number; height: number } },
  ): void {
    const stillSlotted = this.deckState.panes
      .filter((p) => p.slot !== undefined)
      .map((p) => p.activeCardId);
    for (const cardId of stillSlotted) this.cardLifecycle.notifyCardWillMove(cardId);
    const panes = this.deckState.panes.map((p) =>
      p.id === paneId ? { ...p, position: rect.position, size: rect.size } : p,
    );
    this.deckState = {
      ...this.deckState,
      // The card that left keeps its share in the record, exactly as it keeps
      // its place in `order` ([B04]): the rail's other members hold the
      // proportions the hand gave them, and a share naming nobody weighs
      // nothing.
      imposition: withSidebarPinned(
        this.deckState.imposition,
        componentId,
        false,
      ),
      panes,
    };
    this.notify("_unpinSidebar");
    for (const cardId of stillSlotted) this.cardLifecycle.notifyCardDidMove(cardId);
    this.scheduleSave();
  }

  /**
   * Stand the factory deck's rail up beside the deck's first card. Called from
   * {@link addCard} before the card commits, so the rail is pinned first and
   * the new card cascades into the canvas the rail leaves — the same picture a
   * restored deck presents. A rail card opening itself is not the cue.
   */
  private claimFactoryRail(componentId: string): void {
    if (!this.factoryRailPending) return;
    if (isSidebarCard(componentId)) return;
    this.factoryRailPending = false;
    this._createFactoryRail();
  }

  /**
   * Stand every card of {@link FACTORY_RAIL_ORDER} on the rails, in a single
   * state commit.
   *
   * One commit rather than a call to {@link _createSidebarPane} per card: one
   * commit per card would be a notify, a save and a first-responder flip
   * apiece, and the deck would be seen mid-rail on the way to a picture
   * nobody arranged.
   *
   * The panes are appended in **reverse** of {@link FACTORY_RAIL_ORDER}, so
   * Cards lands last. `state.panes` is the deck's z-order and
   * `railFrontmostPaneId` in `components/chrome/deck-canvas.tsx` reads the
   * *last* matching entry, so appending Cards last is what makes it the member
   * you see. The rails' vertical orders are a separate record and are written
   * by {@link factoryDeckImposition}.
   *
   * Each pane takes its height and family policy exactly as
   * {@link _createSidebarPane} does, but its width from its side of
   * {@link FACTORY_RAILS} — never a reopen or preferred width, either of which
   * would stand one member wider than the rest and widen its whole side.
   */
  private _createFactoryRail(): void {
    const seats: { card: CardState; pane: TugPaneState }[] = [];
    const canvasHeight = this.container.clientHeight || 600;

    for (const componentId of [...FACTORY_RAIL_ORDER].reverse()) {
      const registration = getRegistration(componentId);
      if (!registration) {
        console.warn(
          `[DeckManager] _createFactoryRail: no registration for "${componentId}". ` +
            `Register the card before the factory rail stands.`,
        );
        continue;
      }
      const sizePolicy = getSizePolicy(componentId);
      const side: SidebarSide = FACTORY_RAILS.left.order.includes(componentId)
        ? "left"
        : "right";
      const width = Math.max(sizePolicy.min.width, FACTORY_RAILS[side].widthPx);
      const cardId = crypto.randomUUID();
      seats.push({
        card: {
          id: cardId,
          componentId,
          title: registration.defaultMeta.title,
          closable: registration.defaultMeta.closable !== false,
        },
        pane: {
          id: crypto.randomUUID(),
          // Position/height are nominal — the pane render layer pins a sidebar
          // from `imposition.sidebars`. Width is the live rail width.
          position: { x: 0, y: 0 },
          size: { width, height: canvasHeight },
          cardIds: [cardId],
          activeCardId: cardId,
          title: registration.defaultTitle ?? registration.defaultMeta.title,
          acceptsFamilies: registration.acceptsFamilies ?? [],
        },
      });
    }

    if (seats.length === 0) return;
    // Last appended is frontmost, which is the head of FACTORY_RAIL_ORDER.
    const front = seats[seats.length - 1]!;

    this._flipFirstResponder(
      front.card.id,
      () => {
        this.deckState = {
          ...this.deckState,
          cards: [...this.deckState.cards, ...seats.map((seat) => seat.card)],
          panes: [...this.deckState.panes, ...seats.map((seat) => seat.pane)],
          activePaneId: front.pane.id,
          imposition: factoryDeckImposition(this.deckState.imposition),
        };
        this.notify("_createFactoryRail");
        this.scheduleSave();
        for (const seat of seats) {
          this.cardLifecycle.notifyCardDidFinishConstruction(seat.card.id);
        }
        this.putFocusedCardIdGuarded(front.card.id);
      },
      "claimFactoryRail",
    );
  }

  /**
   * Create a sidebar rail — mirrors {@link addCard} but pins the pane to the
   * side the imposition records, spans full height, takes its width from the
   * card's reopen width, and hosts nothing else (`acceptsFamilies: []`).
   */
  private _createSidebarPane(componentId: string): string | null {
    const registration = getRegistration(componentId);
    if (!registration) {
      console.warn(
        `[DeckManager] showSidebarPane: no registration for "${componentId}". ` +
          `Register the card before showing it.`,
      );
      return null;
    }

    const sizePolicy = getSizePolicy(componentId);
    const width = Math.max(
      sizePolicy.min.width,
      this._sidebarReopenWidth(componentId) ?? sizePolicy.preferred.width,
    );
    const canvasHeight = this.container.clientHeight || 600;

    const paneId = crypto.randomUUID();
    const cardId = crypto.randomUUID();
    const card: CardState = {
      id: cardId,
      componentId,
      title: registration.defaultMeta.title,
      closable: registration.defaultMeta.closable !== false,
    };
    const pane: TugPaneState = {
      id: paneId,
      // Position/height are nominal — the pane render layer pins a sidebar
      // from `imposition.sidebars`. Width is the live rail width.
      position: { x: 0, y: 0 },
      size: { width, height: canvasHeight },
      cardIds: [cardId],
      activeCardId: cardId,
      title: registration.defaultTitle ?? registration.defaultMeta.title,
      acceptsFamilies: registration.acceptsFamilies ?? [],
    };

    this._flipFirstResponder(
      cardId,
      () => {
        const panes = [...this.deckState.panes, pane];
        // A sidebar that was dragged loose and then closed comes back at its
        // pin. Only a drag takes it off the pin, and closing it is not one —
        // reopening it into the middle of the deck at a nominal (0, 0) would
        // be the deck inventing a position nobody asked for.
        //
        // A card that comes back to a rail it has a share in stands at that
        // share; one that never had a share joins at weight 1 beside the
        // others' unchanged weights ([B04]). Either way nothing the hand did
        // to the rest of the rail is thrown away.
        const imposition = withSidebarPinned(
          this.deckState.imposition,
          componentId,
          true,
        );
        this.deckState = {
          ...this.deckState,
          cards: [...this.deckState.cards, card],
          panes,
          activePaneId: paneId,
          imposition,
        };
        this.notify("_createSidebarPane");
        this.scheduleSave();
        this.cardLifecycle.notifyCardDidFinishConstruction(cardId);
        this.putFocusedCardIdGuarded(cardId);
      },
      "showSidebarPane",
    );

    return cardId;
  }

  /**
   * The width `componentId` reopens at, or `undefined` when the user has never
   * sized it — {@link sidebarWidthStore} is where every sidebar card keeps it.
   */
  private _sidebarReopenWidth(componentId: string): number | undefined {
    return sidebarWidthStore.widthFor(componentId);
  }

  /**
   * The card a close hands the reader — {@link resolveCloseSuccessor} asked
   * over the live deck, with the place runs this instance has measured.
   *
   * The rule is the pure function's; what belongs to the manager is only the
   * measurement, which is why the reckoning lives in `lib/close-successor.ts`
   * where it can be read against a written-out arrangement.
   */
  private _closeSuccessorCardId(closingPaneId: string): string | null {
    const runs: PlaceRuns = {
      rail: this._placeRunHeight("rail"),
      column: this._placeRunHeight("column"),
    };
    return resolveCloseSuccessor(
      this.deckState,
      runs,
      closingPaneId,
      this._activationHistory,
    );
  }

  /** Move `cardId` to the front of {@link _activationHistory}. */
  private _noteActivation(cardId: string): void {
    const history = this._activationHistory.filter((id) => id !== cardId);
    history.unshift(cardId);
    if (history.length > ACTIVATION_HISTORY_LIMIT) {
      history.length = ACTIVATION_HISTORY_LIMIT;
    }
    this._activationHistory = history;
  }

  /**
   * Close a stack by id.
   *
   * Ordering: when the close owes a handoff, flip the composite bit to
   * {@link _closeSuccessorCardId}'s answer (or `null` when the deck becomes
   * empty) BEFORE firing `cardWillBeginDestruction`. Then fire destruction
   * for every card
   * in the closed stack, mutate to remove the stack and its cards,
   * and notify.
   *
   * Destruction order within the pane: `cardWillBeginDestruction` fires
   * once per card in the pane's `cardIds` array order — not z-order
   * within the pane, not active-card-first. Subscribers that care
   * about relative destruction order between siblings on the same
   * pane should subscribe per-id rather than relying on the wildcard
   * channel's sequence.
   */
  _closePane(paneId: string): void {
    const win = this.deckState.panes.find((s) => s.id === paneId);
    if (!win) return;

    const currentFR = this.getFirstResponderCardId();
    const closedContainsOldFR =
      currentFR !== null && win.cardIds.includes(currentFR);

    // Phase 1: flip the first responder to the successor BEFORE the
    // destruction events. The closed stack is still in state at this point,
    // which is what lets `_closeSuccessorCardId` reckon from the place being
    // vacated; the commit just moves `activePaneId` off the closing stack.
    //
    // Two cases owe a handoff, and the second is why a close used to leave the
    // deck dead: the closing pane held the first responder, OR **nobody did**.
    // A reader who clicked the canvas between cards deselected the deck
    // (`pane-focus-controller`'s `deselect`), and a close from there left
    // `activePaneId` undefined with cards still standing — every title bar
    // inactive, the keyboard nowhere. A close is an activation, so it answers
    // for the deck it leaves behind in both.
    //
    // The third case is deliberately NOT here: a close of some pane while a
    // different one is active changes nothing about focus. The reader is
    // typing in that card, and a close elsewhere must not take the keyboard
    // away from it.
    //
    // Routed through `transferFocusForActivation` on the branch that has a
    // surviving pane to receive focus (`newFR !== null`); when the deck
    // becomes empty there is no incoming card to focus and the raw
    // `_flipFirstResponder` path applies. `outgoingCardId` is `currentFR`,
    // which is `null` in the deselected case — the helper's documented
    // spelling for an activation with no prior active card.
    if (closedContainsOldFR || currentFR === null) {
      const newFR = this._closeSuccessorCardId(paneId);
      const newHost =
        newFR === null
          ? undefined
          : this.deckState.panes.find(
              (s) => s.id !== paneId && s.cardIds.includes(newFR),
            );
      const newActivePaneId = newHost?.id;
      const flipCommit = (): void => {
        this.deckState = {
          ...this.deckState,
          // The successor is its pane's front card in every arrangement the
          // reckoning reads, but the composite bit is the PAIR — write both,
          // so a successor that is somehow not its host's active card still
          // leaves `getFirstResponderCardId()` answering `newFR`.
          ...(newHost !== undefined && newFR !== null
            ? {
                panes: this.deckState.panes.map((s) =>
                  s.id === newHost.id ? { ...s, activeCardId: newFR } : s,
                ),
              }
            : {}),
          ...(newActivePaneId !== undefined
            ? { activePaneId: newActivePaneId }
            : { activePaneId: undefined }),
        };
        this.notify("_closePane");
        this.scheduleSave();
        if (newFR !== null) this.putFocusedCardIdGuarded(newFR);
      };
      if (newFR !== null) {
        transferFocusForActivation({
          outgoingCardId: currentFR,
          incomingCardId: newFR,
          store: this,
          outgoingWillBeDestroyed: true,
          commitMutation: () => {
            this._flipFirstResponder(newFR, flipCommit, "_closePane");
          },
        });
      } else {
        this._flipFirstResponder(newFR, flipCommit, "_closePane");
      }
    }

    // Phase 2: flush each card's save callback then fire destruction.
    // Save-on-close runs BEFORE destruction so the card's last bag
    // lands before subscribers tear down dependent state. [L23].
    //
    // With a departure host registered, motion on, and the pane not still
    // arriving, the destruction is deferred to the settle's land instead
    // ([P01], [P03]): the pane and its cards leave the standing deck in this
    // commit as always, but wait in the departing record, published, until
    // the settle has carried the frame out. Its cards' teardown then runs in
    // the commit after the settle rather than inside its window. An arriving
    // pane was never shown, so there is nothing to carry out.
    const departs =
      this.departureHostCount > 0 &&
      isTugMotionEnabled() &&
      this.deckState.arriving?.[paneId] !== true;
    if (departs) {
      const closing = this.deckState.panes.find((s) => s.id === paneId) ?? win;
      const closingCardIds = new Set(closing.cardIds);
      this.departingRecord.set(paneId, {
        pane: closing,
        cards: this.deckState.cards.filter((c) => closingCardIds.has(c.id)),
        index: this.deckState.panes.findIndex((s) => s.id === paneId),
      });
      this.departingVersion += 1;
    } else {
      for (const cid of win.cardIds) {
        this.flushSaveCallbackBeforeDestruction(cid);
      }
      for (const cid of win.cardIds) {
        this.cardLifecycle.notifyCardWillBeginDestruction(cid);
      }
    }
    const cardIdSet = new Set(win.cardIds);
    const remaining = this.deckState.panes.filter((s) => s.id !== paneId);
    // The reveal the close owes ([P12]), spread into the SAME commit that
    // empties the slot. A close is an activation like any other — the pane
    // that inherits the first responder was raised by this gesture, and the
    // reader was taken there rather than going there — so it is owed the
    // minimal move that brings it fully into its band. Without it a card
    // standing half under a rail stays half under it, now wearing the active
    // livery, which reads as the deck having activated something it will not
    // show.
    //
    // Here rather than in phase 1's flip, and over `remaining` rather than
    // the panes standing: the strip the survivor is revealed INTO is the one
    // the close leaves behind, and the offset that answers for it is only
    // true once the closed pane's extent is out of the sum. Written into
    // phase 1 it would also be a second arrangement change a beat before the
    // one the reader is watching — two crossings for one gesture ([P10]),
    // where a close is one motion: the slot empties and the deck settles
    // onto the card it handed the reader.
    //
    // The rule is minimal and idempotent, so a close that leaves the active
    // card whole in its band spreads nothing and this commit stays
    // byte-identical. The active pane may be the one the flip above just
    // named or the one that held the bit all along — a pane elsewhere in the
    // strip closing still re-sums it, and the survivor is owed the same
    // answer either way.
    const revealPaneId = this.deckState.activePaneId;
    this.deckState = {
      ...this.deckState,
      cards: this.deckState.cards.filter((c) => !cardIdSet.has(c.id)),
      panes: remaining,
      ...(revealPaneId !== undefined
        ? this._revealTerms(revealPaneId, remaining)
        : {}),
    };
    // Discard per-card component-state-preservation registries ([A9]) after
    // destruction notifications have fired — subscribers observing
    // destruction never have a stake in these registries, but ordering
    // after the lifecycle event makes the intent explicit.
    if (!departs) {
      for (const cid of win.cardIds) {
        this.discardComponentStatePreservationRegistry(cid);
      }
    }
    this.notify("_closePane");
    this.scheduleSave();
  }

  /**
   * Flip the composite first-responder bit to `newFR`, running the
   * caller's `commit` between the will and did phases. The central
   * entry point for first-responder transitions.
   *
   * The helper snapshots `oldFR` internally — from
   * `getFirstResponderCardId()` at entry, before any caller code
   * runs. Callers should NOT pre-mutate state that affects the
   * composite bit before calling this method; do all such mutations
   * inside `commit`.
   *
   * Ordering:
   *   - `oldFR === newFR`: run `commit` only. No lifecycle events,
   *     no responder-chain promotion. Callers that want a same-bit
   *     refresh (e.g. re-clicking the already-active card to re-sync
   *     a drifted responder chain) should call
   *     `cardLifecycle.setResponderChainKey(newFR)` themselves after
   *     this method returns.
   *   - `oldFR !== newFR`: `cardWillDeactivate(oldFR)` →
   *     `cardWillActivate(newFR)` → `commit` →
   *     `setResponderChainKey(newFR)` → `cardDidDeactivate(oldFR)` →
   *     `cardDidActivate(newFR)`.
   *
   * `commit` owns the state mutation, `notify()`, and `scheduleSave()`
   * (and any persistence side-effects specific to the caller, e.g.
   * the focused-card record). For the standard promote-a-card-to-FR
   * commit, use `_commitStandardFirstResponderFlip(newFR)`.
   */
  private _flipFirstResponder(
    newFR: string | null,
    commit: () => void,
    trigger: string,
  ): void {
    const oldFR = this.getFirstResponderCardId();
    if (newFR !== null) this._noteActivation(newFR);
    if (oldFR === newFR) {
      commit();
      // Same-bit refresh still counts as a flip trigger for trace
      // purposes — the composite bit's stored value does not change,
      // but callers route through this helper specifically because
      // they produced an intent to flip. Recording here lets a trace
      // reader see the trigger even when the bit collapsed.
      deckTrace.record({
        kind: "fr-flip",
        from: oldFR,
        to: newFR,
        trigger,
      });
      return;
    }
    if (oldFR !== null) this.cardLifecycle.notifyCardWillDeactivate(oldFR);
    if (newFR !== null) this.cardLifecycle.notifyCardWillActivate(newFR);
    this._clearBullseyeOnFocusFlip(newFR);
    perfMark("tug:flip-will-end");
    commit();
    perfMark("tug:flip-commit-end");
    if (newFR !== null) this.cardLifecycle.setResponderChainKey(newFR);
    perfMark("tug:flip-chain-key-end");
    if (oldFR !== null) this.cardLifecycle.notifyCardDidDeactivate(oldFR);
    perfMark("tug:flip-did-deactivate-end");
    if (newFR !== null) this.cardLifecycle.notifyCardDidActivate(newFR);
    perfMark("tug:flip-did-activate-end");
    // Record after the composite bit has changed — matches Spec
    // `deck-trace` ordering ("fr-flip after the composite
    // bit changes"). See list [#l01-recording-sites].
    deckTrace.record({
      kind: "fr-flip",
      from: oldFR,
      to: newFR,
      trigger,
    });
  }

  /**
   * Standard commit body for a first-responder flip: bump `newFR`'s
   * host pane to z-top, set `activePaneId` and the host's
   * `activeCardId = newFR`, persist the focused-card pointer, then
   * notify and schedule a save. No-op on the composite bit when
   * `newFR === null` (clears `activePaneId` without touching
   * z-order or individual pane `activeCardId` fields, and does not
   * persist a focused card).
   *
   * Designed to be passed as the `commit` closure to
   * `_flipFirstResponder`. Use for promote-to-active transitions
   * where the caller has no other state mutation to bundle.
   *
   * `reveal` is whether the raise may slide a strip to bring the member
   * fully in. A pointer activation passes `false` (see
   * `IDeckManagerStore.activateCard`): the hand is on the card, and the
   * one thing a press must never do is move the thing it is pressing.
   */
  private _commitStandardFirstResponderFlip(
    newFR: string | null,
    reveal = true,
  ): void {
    if (newFR === null) {
      this.deckState = { ...this.deckState, activePaneId: undefined };
      this.notify("_commitStandardFirstResponderFlip");
      this.scheduleSave();
      return;
    }
    const stacks = this.deckState.panes;
    const hostIdx = stacks.findIndex((s) => s.cardIds.includes(newFR));
    if (hostIdx === -1) {
      // newFR has no host pane (shouldn't happen in practice). The
      // helper that wraps this commit has already fired
      // cardWillActivate(newFR); returning without mutation leaves
      // the did-phase to run (old behavior preserved) but the
      // composite bit is unchanged.
      return;
    }
    const hostStack = stacks[hostIdx];
    const updatedHost: TugPaneState =
      hostStack.activeCardId === newFR
        ? hostStack
        : { ...hostStack, activeCardId: newFR };

    let newStacks: readonly TugPaneState[];
    const isAtEnd = hostIdx === stacks.length - 1;
    if (isAtEnd && updatedHost === hostStack) {
      newStacks = stacks;
    } else if (isAtEnd) {
      newStacks = stacks.map((s, i) => (i === hostIdx ? updatedHost : s));
    } else {
      const reordered = [...stacks];
      reordered.splice(hostIdx, 1);
      reordered.push(updatedHost);
      newStacks = reordered;
    }

    // The reveal rides THIS commit, so the settle sees the raise and the slide
    // as one arrangement change and animates them together ([P10]). An
    // activation that reveals nothing returns the offset it was given, and the
    // commit stays z-only — which is what keeps a click on an already-visible
    // card from arming a settle it does not owe.
    const revealTerms = reveal
      ? this._revealTerms(updatedHost.id, newStacks)
      : {};

    this.deckState = {
      ...this.deckState,
      panes: newStacks,
      activePaneId: updatedHost.id,
      ...revealTerms,
    };
    this.putFocusedCardIdGuarded(newFR);
    this.notify("_commitStandardFirstResponderFlip");
    this.scheduleSave();
  }

  /**
   * Write the stored flow offset back inside the bounds a resized canvas
   * leaves it — bookkeeping, not the thing that keeps the picture correct.
   *
   * The PICTURE is already right without this: `imposeStyle` expresses the
   * clamp in CSS over the strip width and the live band, so widening the
   * window re-resolves every frame in the browser's own reflow, with no JS in
   * the loop and nothing to wait 200ms for. What this fixes is the NUMBER:
   * left unclamped, the next reveal would compute its minimal move from an
   * offset the deck is no longer showing.
   *
   * Committed straight into the state the caller is about to notify — a
   * clamped offset changes no frame, since CSS was already drawing the clamped
   * value, so there is nothing here for a settle to animate.
   */
  private _retuneFlowOffset(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): void {
    const terms = this._flowRetuneTerms(panes, imposition);
    if (terms === null) return;
    this.deckState = { ...this.deckState, ...terms };
    this.notify("_retuneFlowOffset");
  }

  /**
   * {@link _retuneFlowOffset}'s answer without the commit and without the
   * notify — `null` when the standing offset is already the clamped one.
   *
   * Split out for the one caller that has to fold three retunes and a width
   * solve into a single commit: {@link _resolveShownArrangement} ([P04]).
   */
  private _flowRetuneTerms(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): { flowOffset: number } | null {
    const state = { ...this.deckState, panes };
    const strip = deckFlowStrip(state);
    if (strip === null) return null;
    const standing = state.flowOffset ?? 0;
    const clamped = clampFlowOffset(
      standing,
      strip.width,
      this._flowBandWidth(panes, imposition),
    );
    if (clamped === standing) return null;
    return { flowOffset: clamped };
  }

  /**
   * The band the arrangement is laid across, in px — the canvas less the rails
   * standing on it and the imposition's own gaps — or `null` when there is no
   * positive band to report.
   *
   * **Layout-independent, and that is the point.** Fit spreads its cards across
   * the band and flow slides a longer strip under it, but both are answering
   * the same measurement, and a reader that had to know which mode it was in
   * before it could ask how wide the deck is would be carrying the distinction
   * into places that do not have it. This used to refuse in fit, which made the
   * Layout card's drawing derive its own fit band out of nominal units — and that
   * second derivation is exactly why the plan jumped when the layout toggled.
   *
   * Public because the Layout card's plan draws the committed arrangement to the real
   * proportions, and the strip alone does not say how much of it is on screen —
   * that is the band, and the band is a measurement of the canvas rather than a
   * fact in `DeckState`. Reading it here keeps the deck's one measurement in
   * one place; a second one taken off the DOM in that card would agree with this
   * only by luck.
   *
   * It answers from the container's current width, so a caller reading it
   * during render gets the band the deck last laid out against. A canvas
   * resize re-imposes through the settled-resize retune, which commits and
   * re-renders every subscriber — so the answer follows the window without
   * anything watching it per frame.
   */
  getBandWidth(): number | null {
    const state = this.deckState;
    const band = this._flowBandWidth(state.panes, state.imposition);
    return band > 0 ? band : null;
  }

  /**
   * The band's two edges in canvas layout px, or `null` when there is no band
   * to report — the same measurement as {@link getBandWidth}, answered as
   * where the band is rather than only how wide.
   *
   * Public for the drag: a card carried across a flow deck steps the strip
   * when the hand crosses the rail's inner edge, or the canvas edge when no
   * rail stands there, and the trigger has to agree with the pins the strip
   * is measured against. Both come from {@link flowBandEdges} over the same
   * rail widths, so they agree by construction rather than by two readings
   * of the rails.
   */
  getBandEdges(): FlowBandEdges | null {
    const state = this.deckState;
    const edges = this._flowBandEdges(state.panes, state.imposition);
    return edges.end - edges.start > 0 ? edges : null;
  }

  /**
   * The band's width with no floor — zero or negative when the rails meet or
   * overlap. {@link getBandEdges} answers `null` there, which is right for a
   * reader that needs somewhere to put a card; the rail width drag needs the
   * signed width instead, because the imposed `left` expressions it previews
   * evaluate exactly this and clamp it themselves, and a rail that has covered
   * the deck is the one that most needs to be narrowed back.
   */
  getBandSpan(): number {
    const state = this.deckState;
    return this._flowBandWidth(state.panes, state.imposition);
  }

  /**
   * The slot a fresh card opens into, and whether it lands in a wall — the
   * deck's one answer to where a new card goes, for every opener.
   *
   * The anchor is resolved here rather than by the caller: `origin` when that
   * card holds a slot, else the first responder when IT holds one, else the
   * deck itself. A rail card, a free pane, and a card that is gone all hold
   * no slot, and fall through. The ranking is {@link chooseOpeningSlot}'s,
   * over {@link readOpeningDeck}'s reading of the deck with the two
   * measurements this manager owns: the column run and the flow band.
   *
   * `null` when nothing is imposed, which callers under a multi-slot kind
   * never see.
   */
  openingSlotFor(origin: string | null): OpeningChoice | null {
    const state = this.deckState;
    const run = this._placeRunHeight("column");
    const deck = readOpeningDeck(state, {
      run: run > 0 ? run : null,
      band: this._flowBandWidth(state.panes, state.imposition),
    });
    if (deck === null) return null;
    const anchorSlot =
      this._openingAnchorSlot(origin) ??
      this._openingAnchorSlot(this.getFirstResponderCardId());
    return (
      chooseOpeningSlot(
        deck,
        anchorSlot === undefined
          ? { kind: "deck" }
          : { kind: "origin", slot: anchorSlot },
      ) ?? chooseOpeningSlot(deck, { kind: "deck" })
    );
  }

  /** The slot `cardId` stands in, when it stands in one: not a rail card,
   *  not a free pane, not a card no longer on the deck. */
  private _openingAnchorSlot(cardId: string | null): number | undefined {
    if (cardId === null) return undefined;
    const kind = this.deckState.imposition.kind;
    if (kind === undefined) return undefined;
    const pane = this.deckState.panes.find((p) => p.cardIds.includes(cardId));
    if (pane === undefined || pane.slot === undefined) return undefined;
    if (this._sidebarComponentIdOfPane(pane.id) !== undefined) return undefined;
    return clampSlot(kind, pane.slot);
  }

  /**
   * Everything it costs to show `paneId` whole, as the terms a commit spreads
   * into the state it is about to write: the deck's flow offset, the offset of
   * the column it stands in, and the offset of the rail it stands on.
   *
   * Each of the three slides its own strip by the least that shows the member
   * ([P12]), and each answers `undefined` for a pane already whole in its band
   * — so a commit that reveals nothing spreads nothing and stays
   * byte-identical.
   *
   * One helper rather than the same three questions written out at each site,
   * because the three moments that ask them owe the reader the same thing: a
   * raise, a bare reveal, and a card ARRIVING all mean "show me this card",
   * and the deck has one answer to what that costs. `panes` is what the commit
   * is about to write rather than what it is replacing, for the reason each of
   * the three underneath takes them.
   */
  private _revealTerms(
    paneId: string,
    panes: readonly TugPaneState[],
  ): Partial<DeckState> {
    const flowOffset = this._flowRevealOffsetFor(paneId, panes);
    return {
      ...(flowOffset !== undefined ? { flowOffset } : {}),
      ...this._withColumnReveal(this._columnRevealOffsetFor(paneId, panes)),
      ...this._withRailReveal(this._railRevealOffsetFor(paneId, panes)),
    };
  }

  /**
   * The flow offset that reveals `paneId`, or `undefined` when there is
   * nothing to reveal — not in flow, no strip, or the pane does not ride it.
   *
   * Scoped deliberately: a rail, a free pane, and a bullseyed pane all
   * activate through the same commit, and none of them stands in the strip. A
   * rail is pinned to its edge, a free pane holds its stored position, and
   * bullseye supersedes the mode entirely — moving the viewport for any of
   * them would slide the deck under the user for a card that did not move.
   */
  private _flowRevealOffsetFor(
    paneId: string,
    panes: readonly TugPaneState[],
    imposition?: DeckImposition,
  ): number | undefined {
    // The imposition being COMMITTED, when there is one: `_commitImposition`
    // asks before its record lands, and the mode it is landing is the mode the
    // reveal must answer for.
    const state = {
      ...this.deckState,
      panes,
      ...(imposition !== undefined ? { imposition } : {}),
    };
    const strip = deckFlowStrip(state);
    if (strip === null) return undefined;
    const pane = panes.find((p) => p.id === paneId);
    if (pane === undefined || pane.slot === undefined) return undefined;
    if (this._sidebarComponentIdOfPane(pane.id) !== undefined) return undefined;
    if (state.bullseyePaneId === pane.id) return undefined;
    const slot = clampSlot(
      state.imposition.kind as ImpositionKind,
      pane.slot,
    );
    const stripLeft = strip.positions.get(slot);
    if (stripLeft === undefined) return undefined;
    const next = flowRevealOffset({
      stripLeft,
      extent: paneRenderWidthOf(state, pane),
      stripWidth: strip.width,
      band: this._flowBandWidth(panes, state.imposition),
      offset: state.flowOffset ?? 0,
    });
    return next === (state.flowOffset ?? 0) ? undefined : next;
  }

  /**
   * The vertical run a place's members stand in, in px: the canvas less the
   * gap it keeps at the top and the deeper one it keeps at the bottom.
   *
   * One measurement for both kinds of place, differing only in what the place
   * keeps at each end: a column keeps the card gap and the bottom gap, a rail
   * keeps the rail edge inset and the strip's clearance, which is exactly the
   * distinction the imposer's `RAIL_RUN` and `COLUMN_RUN` draw, so the pins
   * and this number cannot disagree with the CSS by measuring differently.
   *
   * The vertical twin of {@link _flowBandWidth}, and simpler for the reason
   * the overflow pins are simpler than the share pins: nothing insets the run.
   * A rail takes width from the band; nothing takes height from the run.
   */
  private _placeRunHeight(kind: "column" | "rail"): number {
    const top = kind === "rail" ? RAIL_EDGE_INSET_PX : IMPOSITION_GAP_PX;
    const bottom =
      kind === "rail" ? railGapBottomPx() : impositionGapBottomPx();
    return this._containerClientSize().height - top - bottom;
  }

  /** The container's client size, from {@link containerSize}. */
  private _containerClientSize(): { width: number; height: number } {
    if (this.containerSize === null) {
      this.containerSize = {
        width: this.container.clientWidth,
        height: this.container.clientHeight,
      };
    }
    return this.containerSize;
  }

  /**
   * How one side's rail divides the run it is standing in right now — the
   * manager's one door to {@link railAllocationOf}, with the run measured off
   * its own container.
   *
   * `panes` and `imposition` are the ones a commit is ABOUT TO WRITE rather
   * than the ones it is replacing, which is why they are parameters at all:
   * a reveal computed from the state it is leaving would reveal the member
   * that used to be at that index.
   */
  private _railAllocation(
    side: SidebarSide,
    panes?: readonly TugPaneState[],
    imposition?: DeckImposition,
  ): PlaceAllocation | null {
    return railAllocationOf(
      {
        ...this.deckState,
        ...(panes !== undefined ? { panes } : {}),
        ...(imposition !== undefined ? { imposition } : {}),
      },
      side,
      this._placeRunHeight("rail"),
    );
  }

  /** {@link _railAllocation}'s slot-keyed twin. */
  private _columnAllocation(
    slot: number,
    panes?: readonly TugPaneState[],
    imposition?: DeckImposition,
  ): PlaceAllocation | null {
    return columnAllocationOf(
      {
        ...this.deckState,
        ...(panes !== undefined ? { panes } : {}),
        ...(imposition !== undefined ? { imposition } : {}),
      },
      slot,
      this._placeRunHeight("column"),
    );
  }

  /**
   * The run a column's members stand in, in px, or `null` when the canvas has
   * no height to speak of.
   *
   * Public for the reason {@link getBandWidth} is: the Layout card's miniature
   * draws an overflowing column as a strip behind a run, and a stored offset
   * only means something against the run it was measured in. Reading it here
   * keeps the deck's one measurement in one place.
   */
  getColumnRunHeight(): number | null {
    const run = this._placeRunHeight("column");
    return run > 0 ? run : null;
  }

  /** The run a rail's members stand in — {@link getColumnRunHeight}'s twin,
   *  measured from the rail edge inset rather than the card gap. */
  getRailRunHeight(): number | null {
    const run = this._placeRunHeight("rail");
    return run > 0 ? run : null;
  }

  /**
   * The column offset that reveals `paneId` inside its own slot, or
   * `undefined` when there is nothing to reveal — the pane stands in no
   * column, its column is not split, its column does not overflow, or the
   * member is already fully in the run.
   *
   * Exactly parallel to {@link _flowRevealOffsetFor}, over the same arithmetic
   * ({@link stripRevealOffset}) read down instead of across, and scoped the
   * same way: a bullseyed pane supersedes the arrangement, so it does not
   * slide its column under the user for a card that did not move.
   *
   * The strip it measures against is the allocation's own — every overflowing
   * member stands at its own floor, which the allocator answers from the
   * members' registered size policies rather than from any frame — so no pane
   * is measured here, which is what lets the answer be computed inside a
   * commit rather than after a layout.
   */
  private _columnRevealOffsetFor(
    paneId: string,
    panes: readonly TugPaneState[],
    imposition?: DeckImposition,
  ): { slot: number; offset: number } | undefined {
    const state = {
      ...this.deckState,
      panes,
      ...(imposition !== undefined ? { imposition } : {}),
    };
    if (state.bullseyePaneId === paneId) return undefined;
    const pane = panes.find((p) => p.id === paneId);
    if (pane === undefined || pane.slot === undefined) return undefined;
    if (this._sidebarComponentIdOfPane(pane.id) !== undefined) return undefined;
    const run = this._placeRunHeight("column");
    if (!(run > 0)) return undefined;
    const column = deckColumnsOf(state, run).find((c) =>
      c.members.includes(paneId),
    );
    if (column === undefined) return undefined;
    const allocation = column.allocation;
    if (allocation === null || allocation.standing !== "overflow") {
      return undefined;
    }
    const index = column.members.indexOf(paneId);
    const standing = state.columnOffsets?.[column.slot] ?? 0;
    const next = stripRevealOffset({
      stripStart: allocation.tops[index],
      extent: allocation.heights[index],
      stripLength: allocation.stripLength,
      band: run,
      offset: standing,
    });
    return next === standing ? undefined : { slot: column.slot, offset: next };
  }

  /**
   * The column offset a WALL OPEN lands on ([P06]): the opened member's top,
   * less the member above it and the seam between them.
   *
   * The sibling of {@link _columnRevealOffsetFor} rather than a variant of it,
   * because the two answer different questions — that one is minimal, this one
   * is a position (see {@link wallRevealOffset}). It is also computed over the
   * FOLDED panes rather than the standing deck, which is why the caller hands
   * the array in: the strip it measures is the one the fold just made.
   *
   * `undefined` when the column has no allocation to measure, which is a
   * canvas with no run rather than a wall that fits — a wall that fits its run
   * clamps to 0 and is written, because the reveal is a position and 0 is one.
   */
  private _wallRevealFor(
    paneId: string,
    panes: readonly TugPaneState[],
    slot: number,
  ): { slot: number; offset: number } | undefined {
    const run = this._placeRunHeight("column");
    if (!(run > 0)) return undefined;
    const allocation = this._columnAllocation(slot, panes);
    if (allocation === null) return undefined;
    const index = allocation.ids.indexOf(paneId);
    if (index < 0) return undefined;
    return {
      slot,
      offset: wallRevealOffset({
        stripStart: allocation.tops[index] ?? 0,
        leadExtent: index === 0 ? 0 : (allocation.heights[index - 1] ?? 0),
        seam: allocation.seam,
        stripLength: allocation.stripLength,
        band: run,
      }),
    };
  }

  /**
   * The offsets record a reveal produces — the one standing, with the revealed
   * slot's number written over it. `undefined` in gives `undefined` out, so a
   * commit that reveals nothing spreads nothing and stays byte-identical.
   */
  private _withColumnReveal(
    reveal: { slot: number; offset: number } | undefined,
  ): { columnOffsets: Readonly<Record<number, number>> } | Record<string, never> {
    if (reveal === undefined) return {};
    return {
      columnOffsets: {
        ...this.deckState.columnOffsets,
        [reveal.slot]: reveal.offset,
      },
    };
  }

  /**
   * Write every stored column offset back inside the bounds a resized canvas
   * leaves it, and drop the ones whose column has stopped overflowing.
   *
   * Bookkeeping, exactly as {@link _retuneFlowOffset} is bookkeeping: the
   * PICTURE is already right, because `columnMemberPins` expresses the clamp
   * in CSS over the strip and the live run. What this fixes is the NUMBER, so
   * the next reveal computes its minimal move from an offset the deck is
   * actually showing — and it forgets a column that dropped back to two
   * members, whose stored slide would otherwise return with the third card.
   */
  private _retuneColumnOffsets(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): void {
    const terms = this._columnRetuneTerms(panes, imposition);
    if (terms === null) return;
    this.deckState = { ...this.deckState, ...terms };
    this.notify("_retuneColumnOffsets");
  }

  /**
   * {@link _retuneColumnOffsets}'s answer without the commit and without the
   * notify — `null` when no stored column offset moves.
   */
  private _columnRetuneTerms(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): { columnOffsets: Record<number, number> | undefined } | null {
    const standing = this.deckState.columnOffsets;
    if (standing === undefined) return null;
    const state = { ...this.deckState, panes, imposition };
    const run = this._placeRunHeight("column");
    const columns = deckColumnsOf(state, run);
    const next: Record<number, number> = {};
    let changed = false;
    for (const [key, offset] of Object.entries(standing)) {
      const slot = Number(key);
      const column = columns.find((c) => c.slot === slot);
      const allocation = column?.allocation ?? null;
      if (allocation === null || allocation.standing !== "overflow") {
        changed = true;
        continue;
      }
      const clamped = clampStripOffset(offset, allocation.stripLength, run);
      if (clamped !== offset) changed = true;
      next[slot] = clamped;
    }
    if (!changed) return null;
    return Object.keys(next).length === 0
      ? { columnOffsets: undefined }
      : { columnOffsets: next };
  }

  /**
   * Commit where a drag left an overflowing column's strip ([P12], Spec S03).
   *
   * ONE write, at the end of the gesture. The offset moves imperatively on its
   * custom property while the hand is down, and this is the frame where the
   * store catches up with what the deck has been showing — it changes no
   * geometry, because CSS was already drawing this number.
   *
   * That is what `landing` says. A `"cut"` commit declares the frames are
   * already where it puts them, so the settle declines rather than measuring
   * and tweening the column's other members under the user's hand ([B01],
   * [B03]). Staying out of the store used to be the only way to say it; the
   * per-frame writer may still write per frame for cost reasons, but it is no
   * longer forced to.
   *
   * Real state, not a preview, which is why a cancelled drag still commits it:
   * the card goes home, the view does not.
   */
  setColumnOffset(
    slot: number,
    offset: number,
    landing: CommitLanding = "cross",
  ): void {
    const run = this._placeRunHeight("column");
    if (!(run > 0)) return;
    const allocation = this._columnAllocation(slot);
    if (allocation === null || allocation.standing !== "overflow") return;
    const clamped = clampStripOffset(offset, allocation.stripLength, run);
    const standing = this.deckState.columnOffsets?.[slot] ?? 0;
    if (clamped === standing) return;
    this.deckState = {
      ...this.deckState,
      columnOffsets: { ...this.deckState.columnOffsets, [slot]: clamped },
    };
    this.notify("setColumnOffset", landing);
  }

  /**
   * The rail offset that reveals `paneId` inside its own side, or `undefined`
   * when there is nothing to reveal — the pane is not a pinned sidebar, its
   * rail is stacked, its rail does not overflow, or the member is already
   * fully in the run.
   *
   * The side-keyed twin of {@link _columnRevealOffsetFor}, over the same
   * arithmetic ({@link stripRevealOffset}) and the same run. It is a separate
   * method rather than a branch in that one because the two answer about
   * disjoint sets of panes: the column rule returns early for every sidebar
   * pane, and this one returns early for everything else.
   *
   * `panes` rather than `this.deckState.panes` for the reason the column rule
   * takes them: a commit computes its reveal from the panes it is about to
   * write, not from the ones it is replacing.
   */
  private _railRevealOffsetFor(
    paneId: string,
    panes: readonly TugPaneState[],
    imposition?: DeckImposition,
  ): { side: SidebarSide; offset: number } | undefined {
    if (this.deckState.bullseyePaneId === paneId) return undefined;
    const componentId = this._sidebarComponentIdOfPane(paneId);
    if (componentId === undefined) return undefined;
    const arrangement = imposition ?? this.deckState.imposition;
    if (!isSidebarPinned(arrangement, componentId)) return undefined;
    const side = sidebarSide(arrangement, componentId);
    const allocation = this._railAllocation(side, panes, arrangement);
    if (allocation === null || allocation.standing !== "overflow") {
      return undefined;
    }
    const index = allocation.ids.indexOf(componentId);
    if (index < 0) return undefined;
    const run = allocation.run;
    const standing = this.deckState.railOffsets?.[side] ?? 0;
    const next = stripRevealOffset({
      stripStart: allocation.tops[index],
      extent: allocation.heights[index],
      stripLength: allocation.stripLength,
      band: run,
      offset: standing,
    });
    return next === standing ? undefined : { side, offset: next };
  }

  /**
   * The offsets record a rail reveal produces — the one standing, with the
   * revealed side written over it. `undefined` in gives `undefined` out, so a
   * commit that reveals nothing spreads nothing and stays byte-identical.
   */
  private _withRailReveal(
    reveal: { side: SidebarSide; offset: number } | undefined,
  ):
    | { railOffsets: Readonly<Partial<Record<SidebarSide, number>>> }
    | Record<string, never> {
    if (reveal === undefined) return {};
    return {
      railOffsets: {
        ...this.deckState.railOffsets,
        [reveal.side]: reveal.offset,
      },
    };
  }

  /**
   * Write every stored rail offset back inside the bounds a resized canvas
   * leaves it, and drop the ones whose rail has stopped overflowing.
   *
   * Bookkeeping, exactly as {@link _retuneColumnOffsets} is bookkeeping: the
   * PICTURE is already right, because `railMemberPins` expresses the clamp in
   * CSS over the strip and the live run. What this fixes is the NUMBER, so the
   * next reveal computes its minimal move from an offset the deck is actually
   * showing — and it forgets a rail that dropped back to two members, whose
   * stored slide would otherwise return with the third card.
   */
  private _retuneRailOffsets(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): void {
    const terms = this._railRetuneTerms(panes, imposition);
    if (terms === null) return;
    this.deckState = { ...this.deckState, ...terms };
    this.notify("_retuneRailOffsets");
  }

  /**
   * {@link _retuneRailOffsets}'s answer without the commit and without the
   * notify — `null` when no stored rail offset moves.
   */
  private _railRetuneTerms(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): {
    railOffsets: Partial<Record<SidebarSide, number>> | undefined;
  } | null {
    const standing = this.deckState.railOffsets;
    if (standing === undefined) return null;
    const run = this._placeRunHeight("rail");
    const next: Partial<Record<SidebarSide, number>> = {};
    let changed = false;
    for (const [key, offset] of Object.entries(standing)) {
      const side = key as SidebarSide;
      const allocation = this._railAllocation(side, panes, imposition);
      if (allocation === null || allocation.standing !== "overflow") {
        changed = true;
        continue;
      }
      const clamped = clampStripOffset(offset, allocation.stripLength, run);
      if (clamped !== offset) changed = true;
      next[side] = clamped;
    }
    if (!changed) return null;
    return Object.keys(next).length === 0
      ? { railOffsets: undefined }
      : { railOffsets: next };
  }

  /**
   * Commit where a drag left an overflowing rail's strip — the side-keyed twin
   * of {@link setColumnOffset}, and real state for the same reason: the card
   * goes home when a drag is cancelled, the view does not. `landing` carries
   * the same meaning it does there.
   */
  setRailOffset(
    side: SidebarSide,
    offset: number,
    landing: CommitLanding = "cross",
  ): void {
    const run = this._placeRunHeight("rail");
    if (!(run > 0)) return;
    const allocation = this._railAllocation(side);
    if (allocation === null || allocation.standing !== "overflow") return;
    const clamped = clampStripOffset(offset, allocation.stripLength, run);
    const standing = this.deckState.railOffsets?.[side] ?? 0;
    if (clamped === standing) return;
    this.deckState = {
      ...this.deckState,
      railOffsets: { ...this.deckState.railOffsets, [side]: clamped },
    };
    this.notify("setRailOffset", landing);
  }

  /**
   * Commit the height a sheet on `memberId` has stated it needs, or drop the
   * claim with a `null` height ([B01], [B05]).
   *
   * `memberId` is the member the way `placeMembers` names it — a pane id for a
   * column member, a componentId for a rail one — so the caller hands over the
   * id the allocator will look the reservation up by and nothing translates in
   * between.
   *
   * An ordinary commit with the default `"cross"` landing, because the growth
   * and the return ARE ordinary settles ([B06]): the reservation changes the
   * place's allocated heights, which the arrangement signature already carries
   * as a term of its own, so the card arrives at the room through the same
   * machinery every other height change uses.
   *
   * Returns without notifying when the record already reads that way, so a
   * sheet re-reporting the height it last reported — which it does on every
   * resize of its own panel — costs nothing.
   *
   * **A measurement supersedes the opening bid ([B02]).** A bid is what a card
   * DECLARED it needs before anything of it was laid out, and it exists only
   * so the arrival is one motion; the sheet standing on the member is the
   * thing that actually knows, so a claim that is at least as high clears the
   * bid in this same commit, and the sheet going clears it whatever it was.
   * From then on the live measurement is the member's floor, which is what
   * makes a bid that was too small cost one settle instead of clipping the
   * card forever — and what lets the bid be written without any card-state
   * transition having to remember to take it down.
   * {@link sheetClaimWith} is the rule, and states why a claim BELOW a
   * standing bid supersedes nothing.
   *
   * **The FIRST report against a standing bid is held to it ([P04]).** The bid
   * is this very panel's last report while its card stood hidden, written at
   * the reveal ([B04]), so the panel's next live reading is supposed to be the
   * same number. A first report that differs by half a pixel or more is
   * therefore not news about the panel but a defect in the reveal: it records an
   * `opening-bid-mismatch` and commits nothing, so the arrival stays one
   * motion and the evidence is in the ring where somebody can read it. A first
   * report that AGREES hands the number from the bid record to the reservation
   * record and does not notify: the member's floor is the same pixel either
   * way, and the picker's first report lands inside the arrival's own settle
   * window ([P07]), where a notify over a floor that did not move would
   * retarget a settle that is still carrying frames. Every
   * report after the first takes the supersede rule untouched — a picker that
   * grows once its sessions arrive is telling the truth, and the settle it
   * costs is the honest one ([P05]). A `null` is a DROP rather than a report:
   * it is the sheet leaving, not the panel reading, and it neither sets the
   * bit nor spends the comparison.
   */
  setSheetReservation(memberId: string, height: number | null): void {
    const bid = this.deckState.openingBids?.[memberId];
    const isFirstReport =
      bid !== undefined && height !== null && !openingBidReportedFor(memberId);
    if (isFirstReport) {
      // The half-pixel unit is the deck's own, not a new one: the settle reads
      // a frame as changing size only when `Math.abs(first - last) >= 0.5`
      // (`deck-canvas.tsx`), and the arrangement signature rounds every height
      // it carries to the pixel. Half a pixel is therefore the width of the
      // band in which this deck already declines to call something a change,
      // and a rule that recorded a defect below it would be recording noise
      // the rest of the machinery cannot act on.
      if (Math.abs(height - bid) >= 0.5) {
        deckTrace.record({
          kind: "opening-bid-mismatch",
          memberId,
          bid,
          report: height,
        });
        return;
      }
      // The report and the bid agree, which is what [P04] says they will: the
      // bid was measured off this very panel. The two records still have to
      // move — the reservation takes over as the member's floor and the bid
      // comes down — but the member's FLOOR does not change by a pixel, so
      // there is nothing for a settle to carry, and notifying would arm one.
      //
      // That matters because the picker now mounts INSIDE the arrival's settle
      // window ([P07]): its first report lands while the frames are still held
      // at their First sizes, and a notify there retargets the settle in
      // flight and strands a survivor at the height it was being held at. A
      // handoff that changes no allocation is not an arrangement change, and
      // the deck already declines to settle over one.
      const handoff = sheetClaimWith(
        {
          sheetReservations: this.deckState.sheetReservations,
          openingBids: this.deckState.openingBids,
        },
        memberId,
        height,
      );
      clearOpeningBidReport(memberId);
      this.deckState = { ...this.deckState, ...handoff };
      return;
    }
    const next = sheetClaimWith(
      {
        sheetReservations: this.deckState.sheetReservations,
        openingBids: this.deckState.openingBids,
      },
      memberId,
      height,
    );
    if (
      next.sheetReservations === this.deckState.sheetReservations &&
      next.openingBids === this.deckState.openingBids
    ) {
      return;
    }
    // A bid this commit cleared — superseded by the claim, or taken down with
    // the sheet — takes its report bit with it, so the next arrival in this
    // place gets its own first report to compare ([P04]). The clearing lives
    // here rather than inside `sheetClaimWith` because that function is pure
    // and tested as such; this is the moment the supersede actually lands.
    if (next.openingBids !== this.deckState.openingBids) {
      clearOpeningBidReport(memberId);
    }
    this.deckState = { ...this.deckState, ...next };
    this.notify("setSheetReservation");
    if (this.deckState.arriving?.[memberId] === true) {
      tugDevLogStore.debug("arrival", "hidden sheet report", { memberId, height });
    }
    // A report from a sheet on a HIDDEN, arriving member is the height the
    // reveal will write as the bid ([B04]); the watch standing over the
    // member re-asks its decision now that one has landed.
    this.arrivalWatches.get(memberId)?.decide();
  }

  /**
   * Write `memberId`'s opening bid, or drop it with `null` ([B02]).
   *
   * {@link DeckManager.setSheetReservation}'s twin, with the same
   * no-notify-on-no-change guard: a caller that re-bids the height already
   * standing costs nothing rather than arming a settle over frames already
   * where they belong.
   *
   * The ordinary END of a bid is not this verb: a bid is superseded by the
   * first measurement of the sheet it was declared for, which
   * {@link DeckManager.setSheetReservation} does in its own commit. This is
   * the path for a card that goes away before any measurement arrives.
   */
  setOpeningBid(memberId: string, height: number | null): void {
    const next = openingBidsWith(
      this.deckState.openingBids,
      memberId,
      height,
    );
    if (next === this.deckState.openingBids) return;
    this.deckState = { ...this.deckState, openingBids: next };
    this.notify("setOpeningBid");
  }

  /**
   * Draw the deck at `offset` without committing it — the per-frame half of a
   * flow gesture, and the one writer of it ([P11]).
   *
   * It lives on the store rather than in the canvas because the strip that
   * scrubs is in the LAYOUT CARD and the element the offset is written on is the
   * canvas's: a second implementation on that card's side would be a second
   * clamp, a second property, and a second chance to disagree. The store
   * already holds the container it measures the band off, so it is the one
   * place both gestures can reach.
   *
   * It touches no state and notifies nothing — a commit per frame would arm
   * the settle on every one of them and tween the deck under the user's hand.
   *
   * It does remember the offset it drew, and that memory is what the settle
   * after a gesture starts from. The settle's own record of the strip's
   * place advances only on a commit, so without this the slide after a swipe
   * would begin where the strip stood BEFORE the hand touched it, snap the
   * frames back there for a frame, and replay the whole swipe. The one writer
   * is where the truth of what is on screen lives, so it is the one place to
   * keep it: the canvas wheel, the Layout card's scrub and the miniature's
   * drag all land here and all inherit the origin.
   */
  previewFlowOffset(offset: number): void {
    if (deckFlowStrip(this.deckState) === null) return;
    const band = this.getBandWidth();
    if (band === null) return;
    const drawn = Math.round(offset);
    writeCanvasFlowOffset(this.container, drawn);
    this.drawnFlowOffset = drawn;
    publishFlowOffset(offset / band);
  }

  /**
   * The offset {@link previewFlowOffset} last drew and no commit has yet
   * consumed, or `null` when the strip stands where the store says it does.
   *
   * Read by the settle's arm, inside the commit that consumes it, as the
   * origin of its flow slide. It is a fact about the SCREEN rather than the
   * store — which frame the eye is looking at — so it rides beside the state
   * rather than in it and moves no version.
   */
  getDrawnFlowOffset(): number | null {
    return this.drawnFlowOffset;
  }

  /**
   * The hand's velocity at release, in offset px per second, handed over by
   * {@link setDrawnFlowVelocity} and consumed with the drawn offset by the
   * commit that follows — read by the settle's arm as the flow slide's launch
   * velocity. `null` when nobody handed one over.
   */
  getDrawnFlowVelocity(): number | null {
    return this.drawnFlowVelocity;
  }

  /** Hand the next flow commit the hand's velocity. */
  setDrawnFlowVelocity(pxPerSecond: number | null): void {
    this.drawnFlowVelocity = pxPerSecond;
  }

  /** The flow strip's twin of {@link setColumnOffset} — the same one-write-at-
   *  the-end rule, read across instead of down, and the same `landing`. It is
   *  the one of the three with a `"cross"` caller that matters: a strip
   *  segment click and the Center Card chord both hand it a number the deck
   *  was NOT drawing, and the settle tweens the crossing.
   *
   *  Every path out clears the drawn offset: the commit is what consumes a
   *  preview, whether the arm read it (`notify` clears it once its sync
   *  subscribers have run) or there was nothing to arm because the hand came
   *  back to where the store already stood.
   *
   *  A commit of the very number the deck was drawing lands `"cut"` whatever
   *  the caller said: the frames are already where it puts them, which is the
   *  definition of that landing ([F01]), and a `"cross"` here would arm a
   *  settle over a slide of zero length. */
  setFlowOffset(offset: number, landing: CommitLanding = "cross"): void {
    const strip = deckFlowStrip(this.deckState);
    if (strip === null) return;
    const clamped = clampFlowOffset(
      offset,
      strip.width,
      this._flowBandWidth(this.deckState.panes, this.deckState.imposition),
    );
    if (clamped === (this.deckState.flowOffset ?? 0)) {
      this.drawnFlowOffset = null;
      this.drawnFlowVelocity = null;
      return;
    }
    const drawn = this.drawnFlowOffset;
    const resolved =
      drawn !== null && drawn === Math.round(clamped) ? "cut" : landing;
    this.deckState = { ...this.deckState, flowOffset: clamped };
    this.notify("setFlowOffset", resolved);
  }

  /**
   * The band the strip is seen through: the canvas, less each standing rail's
   * inset, less the chain's own gap at either end.
   *
   * The same arithmetic {@link resolveSpan} does — {@link railSpanInsetPx} per
   * occupied side, then one gap at each end of what is left — read off the
   * standing rails rather than by building `SidebarRail` records to hand that
   * function, since a rail's mode, members and seams are nothing this
   * measurement reads.
   */
  private _flowBandWidth(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): number {
    const edges = this._flowBandEdges(panes, imposition);
    return edges.end - edges.start;
  }

  /**
   * The band's edges, from the widest pane standing on each side — the one
   * reading of the rails that {@link _flowBandWidth} and
   * {@link getBandEdges} both answer from.
   */
  private _flowBandEdges(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): FlowBandEdges {
    const { panesBySide } = this._sidebarRails(panes, imposition);
    const state = { ...this.deckState, panes: [...panes] };
    const railWidths: { left?: number; right?: number } = {};
    for (const [side, sidePanes] of panesBySide) {
      let width = 0;
      for (const pane of sidePanes) {
        width = Math.max(width, paneRenderWidthOf(state, pane));
      }
      railWidths[side] = width;
    }
    return flowBandEdges(this._containerClientSize().width, railWidths);
  }

  /**
   * Update a pane's position and size (called on drag-end / resize-end).
   *
   * Fires will/did lifecycle events for move/resize on the **active card** of
   * the pane (panes, not cards, own position/size — but the active card is
   * the observable subject).
   *
   * `opts.evictSlot` releases a pane whose geometry was DERIVED back to free
   * pixels in the same commit — a slotted pane leaves its slot, and a pinned
   * sidebar leaves its pin. The title-bar drag always passes it, because a
   * card dragged somewhere is a card placed by hand. The edge resize passes it
   * only under the deck's "releases" rule; under "keeps its slot" it commits a
   * raw width here without it, the way the width menu does.
   *
   * It stays an explicit option rather than a "geometry changed" heuristic
   * because plenty of commits change geometry without being that gesture — the
   * space allocator's rail solve, the width-preset applier, the imposition
   * freeze — and each of those must leave the pane exactly where the structure
   * put it. The sidebar's deck-facing edge is the one resize that does NOT
   * evict, and it does not reach here at all: it commits through
   * {@link setRailWidth}, which writes the whole rail.
   */
  movePane(
    paneId: string,
    position: { x: number; y: number },
    size: { width: number; height: number },
    opts?: MovePaneOptions,
  ): void {
    const existing = this.deckState.panes.find((s) => s.id === paneId);
    if (!existing) return;
    const sidebarComponentId = this._sidebarComponentIdOfPane(paneId);
    // A sidebar has no slot to evict; the same gesture releases its pin.
    if (
      opts?.evictSlot === true &&
      sidebarComponentId !== undefined &&
      isSidebarPinned(this.deckState.imposition, sidebarComponentId)
    ) {
      this._unpinSidebar(sidebarComponentId, paneId, { position, size });
      return;
    }
    const evictSlot = opts?.evictSlot === true && existing.slot !== undefined;
    const positionChanged =
      existing.position.x !== position.x || existing.position.y !== position.y;
    const sizeChanged =
      existing.size.width !== size.width ||
      existing.size.height !== size.height;

    const activeCardId = existing.activeCardId;
    if (positionChanged) this.cardLifecycle.notifyCardWillMove(activeCardId);
    if (sizeChanged) this.cardLifecycle.notifyCardWillResize(activeCardId);

    // A gesture that places or sizes this pane by hand ends its bullseye.
    // Gated on what CHANGED rather than on `evictSlot`: the drag and resize
    // commits pass that flag but `_setPaneWidth` does not, and every width
    // door reaches here through it. A commit that moves neither position nor
    // size (a re-commit of the same rect) leaves the posture standing.
    if (positionChanged || sizeChanged) this._clearBullseyeFor(paneId);

    this.deckState = {
      ...this.deckState,
      panes: this.deckState.panes.map((s) => {
        if (s.id !== paneId) return s;
        const moved: TugPaneState = { ...s, position, size };
        // The slot's height goes with the slot: it means nothing to a free
        // pane, whose height is `size.height`.
        if (evictSlot) {
          delete moved.slot;
          delete moved.slotHeight;
        }
        if (opts?.slotHeight === null) delete moved.slotHeight;
        else if (opts?.slotHeight !== undefined && !evictSlot) {
          moved.slotHeight = opts.slotHeight;
        }
        // The width stamp follows the width, in one place: a move that names a
        // preset records it, and any OTHER move that changes the width clears
        // it. That is what keeps a hand-dragged edge from leaving a card
        // claiming a preset it no longer sits at.
        if (opts?.widthPreset !== undefined) moved.widthPreset = opts.widthPreset;
        else if (s.size.width !== size.width) delete moved.widthPreset;
        return moved;
      }),
    };
    this.notify("movePane");

    if (positionChanged) this.cardLifecycle.notifyCardDidMove(activeCardId);
    if (sizeChanged) this.cardLifecycle.notifyCardDidResize(activeCardId);

    // A sidebar's live width lives on the pane (persisted in the layout blob),
    // but a hide→show cycle removes the pane, so mirror the committed width to
    // the card's own store as the preferred *reopen* width ([P02]).
    if (sizeChanged && sidebarComponentId !== undefined) {
      sidebarWidthStore.setWidth(sidebarComponentId, size.width);
    }

    this.scheduleSave();
  }

  /**
   * The widths the rail standing on `side` may be given, or `null` when no
   * pinned rail stands there: its hard floor is the tightest member's, and its
   * ceiling is the slim content width the allocator never grants past. The
   * rail width drag reads these rather than deriving bounds of its own, so the
   * hand meets exactly the bounds the allocator solves within.
   */
  railWidthLimits(side: SidebarSide): RailWidthLimits | null {
    const state = this.deckState;
    const policy = this._sidebarRails(state.panes, state.imposition).rails[side];
    if (policy === undefined) return null;
    return railWidthLimitsOf(policy.minWidth, CONTENT_WIDTH_SLIM_PX);
  }

  /**
   * Commit the rail on `side` at `width`: every member of the side, in one
   * state write and one notify. Same-side cards share one rail and the deck
   * reads the rail as wide as its widest member, so writing only the member
   * whose edge was dragged would leave its siblings holding the rail at the
   * old width. Each member's width is mirrored to its card's own store as the
   * width it reopens at ([P02]), as {@link movePane} does for one pane.
   *
   * The width is clamped to {@link railWidthLimits}. The space allocator does
   * not run: the rail's width belongs to the hand ([D183]), and a drag is not
   * one of the moments {@link retuneSidebarAllocation} answers.
   */
  setRailWidth(side: SidebarSide, width: number): void {
    const limits = this.railWidthLimits(side);
    if (limits === null) return;
    const state = this.deckState;
    const members = findSidebarPanes(state).filter(
      ({ componentId }) =>
        isSidebarPinned(state.imposition, componentId) &&
        sidebarSide(state.imposition, componentId) === side,
    );
    const committed = clampRailWidth(width, limits);
    const { panes, resized } = withRailWidth(
      state.panes,
      new Set(members.map(({ pane }) => pane.id)),
      committed,
    );
    if (resized.length === 0) return;
    for (const pane of resized) {
      this.cardLifecycle.notifyCardWillResize(pane.activeCardId);
    }
    this.deckState = { ...state, panes };
    this.notify("setRailWidth");
    for (const pane of resized) {
      this.cardLifecycle.notifyCardDidResize(pane.activeCardId);
    }
    for (const { componentId } of members) {
      sidebarWidthStore.setWidth(componentId, committed);
    }
    this.scheduleSave();
  }

  /**
   * Bring a card to front by moving its host stack to the end of the
   * `stacks` array. End-of-array = highest z-index by render order.
   *
   * Persists `focusedCardId` to tugbank (fire-and-forget) on every call so
   * clicking an already-focused card still updates the reload restoration
   * pointer. Also calls scheduleSave() so z-order changes land in the layout
   * blob.
   */
  focusCard(cardId: string): void {
    const stacks = this.deckState.panes;
    const hostStackIndex = stacks.findIndex((s) => s.cardIds.includes(cardId));

    if (hostStackIndex !== -1) {
      this.putFocusedCardIdGuarded(cardId);
    }

    if (hostStackIndex === -1 || hostStackIndex === stacks.length - 1) {
      if (hostStackIndex !== -1) {
        this.scheduleSave();
      }
      return;
    }
    const newStacks = [...stacks];
    const [focused] = newStacks.splice(hostStackIndex, 1);
    newStacks.push(focused);
    this.deckState = {
      ...this.deckState,
      panes: newStacks,
      activePaneId: focused.id,
    };
    this.notify("focusCard");
    this.scheduleSave();
  }

  // ---- Stack rotation ----

  /**
   * Move `paneId` to sit immediately below `belowPaneId` in z-order
   * (array order). The Previous-Card-in-Stack primitive: demoting a
   * slot's front pane behind its bottom member is the exact inverse of
   * raising the buried-longest one, which is what makes the two
   * directions a ring rather than an MRU ping-pong.
   *
   * Reorder only — no geometry changes, so no move/resize lifecycle
   * events. The caller owns activation of whichever pane this fronts
   * (via `transferFocusForActivation`, so the focus discipline holds).
   */
  sendPaneBehind(paneId: string, belowPaneId: string): void {
    if (paneId === belowPaneId) return;
    const panes = this.deckState.panes;
    const fromIdx = panes.findIndex((s) => s.id === paneId);
    if (fromIdx === -1) return;
    const next = [...panes];
    const [moved] = next.splice(fromIdx, 1);
    const toIdx = next.findIndex((s) => s.id === belowPaneId);
    if (toIdx === -1) return;
    next.splice(toIdx, 0, moved);
    this.deckState = { ...this.deckState, panes: next };
    this.notify("sendPaneBehind");
    this.scheduleSave();
  }

  // ---- Layout imposition ----

  /**
   * What the imposition gestures in `layout-imposition.ts` act through: the
   * live deck, this store's public surface, and the commit primitives they
   * share with the rest of the manager. Built once; every member reads `this`
   * at call time, so it is safe to build before the constructor body runs.
   */
  private readonly impositionDeps: ImpositionDeps = {
    store: this,
    deck: () => this.deckState,
    setDeck: (next) => {
      this.deckState = next;
    },
    notify: (caller) => this.notify(caller),
    scheduleSave: () => this.scheduleSave(),
    lifecycle: () => this.cardLifecycle,
    commitImposition: (imposition, panes, opts) =>
      this._commitImposition(imposition, panes, opts),
    withSidebarsPinned: (imposition) => this._withSidebarsPinned(imposition),
    pinSidebars: () => this.pinSidebars(),
    detachCard: (paneId, cardId, position) =>
      this._detachCard(paneId, cardId, position),
    clearBullseyeFor: (paneId) => this._clearBullseyeFor(paneId),
    placeRunHeight: (kind) => this._placeRunHeight(kind),
    revealAfterTravel: (cardId) => this._revealAfterTravel(cardId),
    movePane: (paneId, position, size, opts) =>
      this.movePane(paneId, position, size, opts),
  };

  /** See `layout-imposition.ts`. */
  setImposition(kind: ImpositionKind | null): void {
    layoutImposition.setImposition(this.impositionDeps, kind);
  }

  /** See `layout-imposition.ts`. */
  setImpositionLayout(layout: ImpositionLayout): void {
    layoutImposition.setImpositionLayout(this.impositionDeps, layout);
  }

  /** See `layout-imposition.ts`. */
  setResizeSlot(resizeSlot: ResizeSlot): void {
    layoutImposition.setResizeSlot(this.impositionDeps, resizeSlot);
  }

  /** See `layout-imposition.ts`. */
  fillPaneHeight(paneId: string): void {
    layoutImposition.fillPaneHeight(this.impositionDeps, paneId);
  }

  /**
   * Assign a card to a numbered slot in the active imposition. One card is
   * the degenerate batch — {@link assignCardsToSlots} is the implementation,
   * so the single-card and multi-card gestures cannot drift.
   */
  assignCardToSlot(cardId: string, slot: number): SlotAssignment {
    return this.assignCardsToSlots([{ cardId, slot }]);
  }

  /**
   * Assign several cards to slots as one arrangement. See
   * `layout-imposition.ts` — it clears each re-placed pane's bullseye through
   * `deps.clearBullseyeFor`, since it writes `slot` on its own path.
   */
  assignCardsToSlots(
    entries: readonly { readonly cardId: string; readonly slot: number }[],
  ): SlotAssignment {
    return layoutImposition.assignCardsToSlots(this.impositionDeps, entries);
  }

  /** See `layout-imposition.ts`'s `impositionSeating`. */
  private _impositionSeating(
    imposition: DeckImposition,
    panes: readonly TugPaneState[],
    paneId: string,
    slot: number,
    index?: number,
    session?: Pick<DeckState, "openingBids" | "arriving">,
    weighSeated = false,
  ): DeckImposition {
    return layoutImposition.impositionSeating(
      this.impositionDeps,
      imposition,
      panes,
      paneId,
      slot,
      index,
      session,
      weighSeated,
    );
  }

  /**
   * Move a whole pane to `slot` — the drop-zone drag's commit ([P10]). See
   * `layout-imposition.ts`; it clears the pane's bullseye through
   * `deps.clearBullseyeFor`, since it writes `slot` on its own path.
   */
  movePaneToSlot(paneId: string, slot: number, index?: number): SlotAssignment {
    return layoutImposition.movePaneToSlot(this.impositionDeps, paneId, slot, index);
  }
  // ---- Per-card state cache API ([D01], [D06]) ----

  getCardState(cardId: string): CardStateBag | undefined {
    return this.cardStates.get(cardId);
  }

  setCardState(cardId: string, bag: CardStateBag): void {
    this.cardStates.set(cardId, bag);
  }

  /**
   * Capture `cardId`'s current bag and persist it durably immediately,
   * skipping the debounce window. The prompt entry calls this on submit:
   * `editor.clear()` empties the draft, but the debounced save that would
   * persist the cleared state is still pending, and WKWebView fires no
   * `beforeunload`/`visibilitychange` on quit — so a relaunch in that window
   * would otherwise restore the just-submitted message from the stale
   * pre-submit bag. Forcing the write here closes the window independent of
   * the quit path.
   */
  flushCardStateNow(cardId: string): void {
    this.cardStates.flushNow(cardId, this.captureCardState(cardId));
  }

  /** See `CardStateCache.suspendSaves`. */
  suspendCardStateSaves = (): (() => void) => this.cardStates.suspendSaves();

  /** See `CardStateCache.flushDirty`. */
  private flushDirtyCardStates(options?: { keepalive?: boolean; sync?: boolean; force?: boolean }): Promise<CardFlushResult[]> {
    return this.cardStates.flushDirty(options);
  }

  // ---- Save callback registration ([D01]) ----

  registerSaveCallback(id: string, callback: (source?: SaveCallbackSource) => void): void {
    this.cardStates.registerSaveCallback(id, callback);
  }

  unregisterSaveCallback(id: string): void {
    this.cardStates.unregisterSaveCallback(id);
  }

  /** See `CardStateCache.invokeSaveCallback`. */
  invokeSaveCallback(id: string, source?: SaveCallbackSource): void {
    this.cardStates.invokeSaveCallback(id, source);
  }

  // ---- Focus-transfer channels (focus-transfer.ts seam) ----

  /**
   * Content-factory activation callbacks, keyed by cardId. Written by
   * `useCardStatePreservation` (through the context-provided register
   * helper) on every mount of a card whose content component opts in
   * via `options.onCardActivated`. Last-write-wins per cardId.
   */
  private activationCallbacks: Map<string, () => void> = new Map();

  /**
   * Per-card deactivation callbacks (parallel to
   * {@link activationCallbacks}). [L23]:
   * fires when a card is about to lose focus-destination status, so
   * the consumer can route its selection into the inactive-paint
   * channel via `paintMirrorAsInactive(publish)` before the new
   * active card claims focus + global Selection.
   */
  private deactivationCallbacks: Map<string, () => void> = new Map();

  /**
   * Live `[data-card-host][data-card-id="…"]` elements, keyed by
   * cardId. Written by `CardHost` from a callback-ref so mount,
   * unmount, and (if it ever occurs) element-identity changes are all
   * covered.
   */
  private cardHostRoots: Map<string, HTMLElement> = new Map();

  registerActivationCallback(cardId: string, callback: () => void): () => void {
    this.activationCallbacks.set(cardId, callback);
    return () => {
      // Only clear when we still own the slot. A later `register`
      // for the same cardId will have displaced us; its cleanup
      // owns the removal.
      if (this.activationCallbacks.get(cardId) === callback) {
        this.activationCallbacks.delete(cardId);
      }
    };
  }

  invokeActivationCallback(cardId: string, dispatchedFrom: string): void {
    const callback = this.activationCallbacks.get(cardId);
    if (callback === undefined) return;

    // Record the engine-activation-dispatched trace event ahead of
    // invoking the callback so the trace ring's order matches
    // dispatch order. The factory's onCardActivated body stays
    // simple — focus the engine root, that's it; the framework
    // owns the observability surface.
    const card = this.deckState.cards.find((c) => c.id === cardId);
    if (card !== undefined) {
      deckTrace.record({
        kind: "engine-activation-dispatched",
        cardId,
        engine: card.componentId,
        dispatchedFrom,
      });
    }

    callback();
  }

  registerDeactivationCallback(cardId: string, callback: () => void): () => void {
    this.deactivationCallbacks.set(cardId, callback);
    return () => {
      if (this.deactivationCallbacks.get(cardId) === callback) {
        this.deactivationCallbacks.delete(cardId);
      }
    };
  }

  invokeDeactivationCallback(cardId: string, _dispatchedFrom: string): void {
    const callback = this.deactivationCallbacks.get(cardId);
    if (callback === undefined) return;
    callback();
  }

  registerCardHostRoot(cardId: string, el: HTMLElement | null): void {
    if (el === null) {
      this.cardHostRoots.delete(cardId);
    } else {
      this.cardHostRoots.set(cardId, el);
    }
  }

  peekCardHostRoot(cardId: string): HTMLElement | null {
    return this.cardHostRoots.get(cardId) ?? null;
  }


  // ---- Engine hooks (Phase E.11 single-channel dispatcher seam) ----

  /** Per-card engine hooks and their change listeners. */
  private readonly engineHooks = new EngineHookRegistry();

  registerEngineHooks(cardId: string, hooks: EngineHooks): () => void {
    return this.engineHooks.register(cardId, hooks);
  }

  invokeEnginePaintMirrorAsActive(cardId: string): void {
    this.engineHooks.paintMirrorAsActive(cardId);
  }

  invokeEnginePaintMirrorAsInactive(cardId: string): void {
    this.engineHooks.paintMirrorAsInactive(cardId);
  }

  hasEngineHooks(cardId: string): boolean {
    return this.engineHooks.has(cardId);
  }

  /**
   * Subscribe to engine-hook registration events for `cardId`. Used by
   * `CardHost` to re-fire its cold-boot RESTORE effect when a
   * late-mounting engine registers.
   */
  subscribeEngineHooksChange(
    cardId: string,
    listener: () => void,
  ): () => void {
    return this.engineHooks.subscribeChange(cardId, listener);
  }

  /**
   * The per-card Component State Preservation Protocol registry ([D13],
   * [A9]) for `cardId`, created lazily. Used by
   * `useComponentStatePreservation` to register capture/restore closures.
   */
  getComponentStatePreservationRegistry(cardId: string): ComponentStatePreservationRegistry {
    return this.componentStateRegistries.get(cardId);
  }

  /** The card's registry without creating one. */
  peekComponentStatePreservationRegistry(
    cardId: string,
  ): ComponentStatePreservationRegistry | undefined {
    return this.componentStateRegistries.peek(cardId);
  }

  /**
   * Discard the per-card component state preservation registry for
   * `cardId`. Called from `_removeCard` and `_closePane` alongside
   * `flushSaveCallbackBeforeDestruction` so a card's registered
   * closures don't outlive the card itself.
   */
  private discardComponentStatePreservationRegistry(cardId: string): void {
    this.componentStateRegistries.discard(cardId);
  }

  /**
   * Register a card-level assembler with the framework orchestrator
   * ([A9c]). Called by `CardHost` from a `useLayoutEffect`; returned
   * function unregisters on cleanup. The orchestrator invokes the
   * assembler's `capture()` on every save trigger.
   */
  registerCardAssembler(cardId: string, assembler: CardAssembler): () => void {
    return this.cardStateOrchestrator.registerAssembler(cardId, assembler);
  }

  /**
   * Capture the full `CardStateBag` for `cardId` via the orchestrator
   * — framework axes from the registered assembler, plus component
   * state harvested parent-first from the card's
   * `ComponentStatePreservationRegistry`. Single entry point for every
   * save trigger; guarantees `bag.components` lands with every save by
   * construction ([D13], [AT0017]).
   */
  captureCardState(cardId: string, source?: SaveCallbackSource): CardStateBag {
    return this.cardStateOrchestrator.captureCardState(cardId, source);
  }

  /**
   * Flush a card's save callback before the card's own destruction
   * runs. Called by close paths (`_removeCard`, `_closePane`) so the
   * card's last unsaved edits land in the bag before
   * `cardWillBeginDestruction` subscribers tear down dependent state
   * (engine teardown, session release, etc.). The save
   * runs BEFORE the destruction notification — the reverse order
   * would let a destruction subscriber invalidate the state the save
   * callback is trying to read.
   *
   * The callback is wrapped in `try/catch` so a single
   * throwing save never blocks the destruction. In dev, a throw is
   * logged with enough context to find the offending card; in
   * production the failure is swallowed silently — the alternative
   * (blocking destruction and leaving the deck in an inconsistent
   * state) is strictly worse.
   */
  private flushSaveCallbackBeforeDestruction(cardId: string): void {
    try {
      this.invokeSaveCallback(cardId, "close-handoff");
    } catch (err) {
      if (isDevEnv()) {
        console.warn(
          `[deck-manager] save callback threw during close for card "${cardId}"; ` +
            `destruction proceeds regardless.`,
          err,
        );
      }
    }
  }

  // ---- Teardown saves (`teardown.ts`) ----

  /**
   * Iterate every active card, fire its registered save callback
   * tagged with `reason` for the deck-trace ring, flush any pending
   * debounced layout save first, and drain the dirty-card-state
   * queue synchronously.
   *
   * Used by every teardown-class signal that wants the framework to
   * capture user-visible state into bags before a transition that
   * may tear down DOM:
   *
   *   - `beforeunload` — the page is about to navigate / reload.
   *     `handleBeforeUnload` calls in with `reason = "beforeunload"`.
   *   - HMR module replacement — Vite's `vite:beforeUpdate` event;
   *     the bridge in `hmr-bridge.ts` calls in with
   *     `reason = "hmr"`.
   *   - HMR full reload — Vite's `vite:beforeFullReload` event;
   *     the bridge calls in with `reason = "hmr-full-reload"`. (A
   *     defensive sibling of `beforeunload`; if both fire, the
   *     second is a no-op via the early-out below.)
   *
   * Idempotent against `reloadPending` / `stateFlushed`. When one
   * of those flags is set — because `prepareForReload` or
   * `saveAndFlushSync` already drained the framework — this method
   * is a no-op. Multiple teardown signals firing in close
   * succession therefore can't double-save: the second one
   * early-returns. Distinct from `saveAndFlushSync`, which is a
   * forced flush that sets `stateFlushed = true` to lock the
   * framework against further saves; `captureAllForTeardown` does
   * not lock.
   *
   * [L23] (preserve user-visible state across known transitions);
   * [L10] (deck-manager owns layout / orchestration; per-card save
   * is dispatched through `invokeSaveCallback` rather than reaching
   * into card internals).
   */
  captureAllForTeardown(reason: SaveCallbackSource): void {
    if (this.reloadPending || this.stateFlushed) return;
    void this.teardownSave(reason, { sync: true });
  }

  /** What the teardown-save core reaches on this manager. */
  private readonly teardownDeps: TeardownSaveDeps = {
    takePendingLayoutSave: () => this.persistence.takePendingSave(),
    saveLayout: () => this.saveLayout(),
    saveCallbackIds: () => this.cardStates.saveCallbackIds(),
    invokeSaveCallback: (cardId, source) => this.invokeSaveCallback(cardId, source),
    flushDirtyCardStates: (options) => this.flushDirtyCardStates(options),
  };

  /**
   * The teardown-save core every teardown-class path runs through —
   * see `teardown.teardownSave` for the guarantee and its order.
   */
  private teardownSave(
    source: SaveCallbackSource,
    options?: TeardownSaveOptions,
  ): Promise<TeardownSaveResult> {
    return teardown.teardownSave(this.teardownDeps, source, options);
  }

  /**
   * The deck's half of an application quit, run to completion before the
   * host signals any child process — see `teardown.runTerminationPipeline`
   * for its four phases. Never rejects and never blocks indefinitely.
   * Re-entrant calls join the first run's promise. [L23]
   */
  prepareForTermination(): Promise<TerminationVerdict> {
    if (this.terminationRun !== null) return this.terminationRun;
    this.terminationRun = teardown.runTerminationPipeline({
      teardownSave: (source, options) => this.teardownSave(source, options),
      saveLayout: () => this.saveLayout(),
      flushDirtyCardStates: (options) => this.flushDirtyCardStates(options),
      interruptLiveSessions: () => this.interruptLiveSessions(),
      lockSaves: () => {
        this.stateFlushed = true;
      },
    });
    return this.terminationRun;
  }

  private terminationRun: Promise<TerminationVerdict> | null = null;

  /**
   * Interrupt every live session and wait for each to settle, bounded.
   * Public because the update wizard's *Stop work in flight* row runs it
   * as well as the termination pipeline; one implementation, in
   * `teardown.interruptLiveSessions`.
   */
  interruptLiveSessions(): Promise<{
    interrupted: string[];
    unacknowledged: string[];
  }> {
    return teardown.interruptLiveSessions();
  }

  saveAndFlushSync(): void {
    void this.teardownSave("manual", { sync: true });
    this.stateFlushed = true;
  }

  saveAndFlush(): void {
    void this.teardownSave("manual");
  }

  async prepareForReload(): Promise<void> {
    // `force` bypasses the save-suspend gate: a transcript load in
    // flight must not turn this flush into a no-op — `reloadPending`
    // below makes the beforeunload backstop skip, so this is the last
    // write before the page tears down. [L23]
    await this.teardownSave("manual", { layoutSave: "always", force: true });
    this.reloadPending = true;
  }

  // ---- Test-mode state seeding ([D02], `deck-manager-test-seed.ts`) ----

  /**
   * Replace the current `DeckState` atomically, merge per-card state
   * bags into the cache, and optionally activate a focused card — the
   * harness's one-commit seed. The work is `deck-manager-test-seed.ts`'s;
   * this keeps the name every harness and test calls.
   */
  seedDeckState(args: SeedDeckStateArgs): void {
    seedDeckState(
      {
        reapDepartures: () => this._reapDepartures(),
        deck: () => this.deckState,
        setDeck: (state) => {
          this.deckState = state;
        },
        reflectAppActive: (active) => this.reflectAppActive(active),
        seedCardState: (cardId, bag) => this.cardStates.seed(cardId, bag),
        notifyCardDidFinishConstruction: (cardId) =>
          this.cardLifecycle.notifyCardDidFinishConstruction(cardId),
        discardComponentStateRegistry: (cardId) => this.componentStateRegistries.discard(cardId),
        notify: (caller) => this.notify(caller),
        activateCard: (cardId) => {
          this.activateCard(cardId);
        },
      },
      args,
    );
  }

  // ---- Stack/card mutators () ----

  /**
   * Add a new card to an existing stack. Creates a fresh card, appends its id
   * to the stack's `cardIds`, and sets it as the stack's `activeCardId`.
   *
   * When `paneId` is the deck's active
   * stack, the new card becomes first responder (full flip). When it is
   * not, the new card becomes the stack's active-in-stack but the deck's
   * composite first-responder bit is unchanged (no lifecycle events).
   */
  private _addCardToPane(
    paneId: string,
    componentId: string,
    initialContent?: unknown,
  ): string | null {
    const win = this.deckState.panes.find((s) => s.id === paneId);
    if (!win) {
      console.warn(`[DeckManager] addCardToPane: stack "${paneId}" not found.`);
      return null;
    }
    const registration = getRegistration(componentId);
    if (!registration) {
      console.warn(
        `[DeckManager] addCardToPane: no registration found for componentId "${componentId}".`,
      );
      return null;
    }

    const cardId = crypto.randomUUID();
    const newCard: CardState = {
      id: cardId,
      componentId,
      title: registration.defaultMeta.title,
      closable: registration.defaultMeta.closable !== false,
    };

    // Seed the bag BEFORE construction so the card mounts through the
    // restore path with the payload in hand (mirrors `addCard`).
    if (initialContent !== undefined) {
      this.cardStates.seed(cardId, { content: initialContent });
    }

    const isActiveStack = paneId === this.deckState.activePaneId;
    // Post-mutation the stack's `activeCardId` is always `cardId`; the
    // composite bit only flips when the stack is the deck's active stack.
    // For the inactive-stack case pass the current FR so the helper
    // recognizes same-bit (no lifecycle events).
    const newFR = isActiveStack ? cardId : this.getFirstResponderCardId();

    const updatedStack: TugPaneState = {
      ...win,
      cardIds: [...win.cardIds, cardId],
      activeCardId: cardId,
    };

    // Single-commit flip. Construction fires inside commit so it lands
    // between the will and did phases for transition 5a, and right after
    // the commit-notify for transition 5b (inactive-stack, same-bit).
    this._flipFirstResponder(
      newFR,
      () => {
        this.deckState = {
          ...this.deckState,
          cards: [...this.deckState.cards, newCard],
          panes: this.deckState.panes.map((s) => (s.id === paneId ? updatedStack : s)),
        };
        this.notify("_addCardToPane");
        this.scheduleSave();
        this.cardLifecycle.notifyCardDidFinishConstruction(cardId);
        if (isActiveStack) this.putFocusedCardIdGuarded(cardId);
      },
      "_addCardToPane",
    );

    return cardId;
  }

  /**
   * Remove a card from a stack.
   *
   * If the card is the only one in the stack, closes the whole stack via
   * `_closePane`. Otherwise removes the card from `deckState.cards` and
   * from the stack's `cardIds`, reassigning `activeCardId` if needed.
   *
   * **Save-on-close invariant ([L23]):** the card's save
   * callback fires BEFORE `notifyCardWillBeginDestruction`, so the
   * last unsaved bag (scroll, DOM-selection, focus, form-controls,
   * region-scroll, engine content) lands in tugbank before
   * destruction subscribers release any dependent state. A throwing
   * save callback is caught and dev-warned; destruction proceeds
   * regardless.
   *
   * Transition 8a: when the removed card is the first responder — or when
   * nothing is, which is a deselected deck the close owes an activation to —
   * flip the composite bit to the neighbor BEFORE firing
   * `cardWillBeginDestruction`.
   */
  private _removeCard(paneId: string, cardId: string): void {
    const win = this.deckState.panes.find((s) => s.id === paneId);
    if (!win) return;
    if (!win.cardIds.includes(cardId)) return;

    if (win.cardIds.length === 1) {
      this._closePane(paneId);
      return;
    }

    const currentFR = this.getFirstResponderCardId();
    const wasRemovingFR = currentFR === cardId;
    // The same two cases `_closePane`'s phase 1 answers for: the tab being
    // removed held the first responder, or nobody did. A deselected deck that
    // loses a tab still has the neighbour standing where the reader is
    // looking, and handing it the bit is what makes the close read as an
    // activation rather than as a disappearance.
    const owesHandoff = wasRemovingFR || currentFR === null;
    const spliced = spliceCardFromStack(win, cardId);
    // `cardIds.length > 1` above guarantees a survivor → activeCardId !== null.
    // When the front tab goes, the tab that takes its place is the sibling the
    // reader activated most recently, not the one beside it; the positional
    // pick stands in only for siblings the history has never seen.
    const recentSibling =
      win.activeCardId === cardId
        ? this._activationHistory.find((id) => spliced.cardIds.includes(id))
        : undefined;
    const newActiveCardId = recentSibling ?? (spliced.activeCardId as string);

    // Phase 1 (FR-removal only): flip composite bit to the neighbor
    // BEFORE destruction. Commit updates `win.activeCardId` but
    // leaves `cardId` in `win.cardIds` — destruction in phase 2
    // removes it. Two commits, two notifies.
    //
    // Routed through `transferFocusForActivation`. The helper's `commitMutation`
    // closure is the entire `_flipFirstResponder` call so the
    // existing will/commit/did ordering is preserved inside the
    // `flushSync` boundary, and the new FR's card host is mounted
    // and visible before focus transfer runs.
    //
    // `outgoingWillBeDestroyed: true` skips the helper's outgoing
    // save step — phase 2 below runs `flushSaveCallbackBeforeDestruction`
    // for the same card, which is the canonical destruction-flush.
    // Saving twice would mask the destruction-ordering audit (P9).
    if (owesHandoff) {
      transferFocusForActivation({
        // `null` in the deselected case: there is no outgoing first responder,
        // which is the helper's documented spelling for it.
        outgoingCardId: wasRemovingFR ? cardId : null,
        incomingCardId: newActiveCardId,
        store: this,
        outgoingWillBeDestroyed: true,
        commitMutation: () => {
          this._flipFirstResponder(
            newActiveCardId,
            () => {
              const flippedStack: TugPaneState = {
                ...win,
                activeCardId: newActiveCardId,
              };
              this.deckState = {
                ...this.deckState,
                panes: this.deckState.panes.map((s) =>
                  s.id === paneId ? flippedStack : s,
                ),
                // The composite bit is the pair, and on a deselected deck the
                // pane half is missing — without this the flip would write an
                // active card into a pane the deck does not consider active
                // and `getFirstResponderCardId()` would still answer `null`.
                activePaneId: paneId,
              };
              this.notify("_removeCard");
              this.scheduleSave();
              this.putFocusedCardIdGuarded(newActiveCardId);
            },
            "_removeCard",
          );
        },
      });
    }

    // Phase 2: save, then destruction + removal. Save runs first so
    // the card's last bag is flushed before subscribers tear down
    // dependent state. [L23].
    this.flushSaveCallbackBeforeDestruction(cardId);
    this.cardLifecycle.notifyCardWillBeginDestruction(cardId);
    const currentStack =
      this.deckState.panes.find((s) => s.id === paneId) ?? win;
    const finalStack: TugPaneState = {
      ...currentStack,
      cardIds: currentStack.cardIds.filter((id) => id !== cardId),
    };
    const finalPanes = this.deckState.panes.map((s) =>
      s.id === paneId ? finalStack : s,
    );
    // The same reveal `_closePane` owes, over the case where the slot keeps
    // its pane: the card left standing was raised by this gesture, and a
    // stack that loses a member can change the width its size policy asks for
    // and the height its column allocates it — either of which can leave the
    // survivor hanging past a band the reader is looking through. Minimal and
    // idempotent, so a pane already whole spreads nothing.
    const revealPaneId = this.deckState.activePaneId;
    this.deckState = {
      ...this.deckState,
      cards: this.deckState.cards.filter((c) => c.id !== cardId),
      panes: finalPanes,
      ...(revealPaneId !== undefined
        ? this._revealTerms(revealPaneId, finalPanes)
        : {}),
    };
    this.discardComponentStatePreservationRegistry(cardId);
    this.notify("_removeCard");
    this.scheduleSave();
  }

  /**
   * Set the active card in a stack. No-op if `cardId` is not in the
   * stack or is already the stack's `activeCardId`.
   *
   * Transition 2 vs transition-5b's sibling:
   *   - When `paneId` is the deck's active stack, flipping the stack's
   *     active-in-stack card also flips the composite first-responder
   *     bit. Route through `_flipFirstResponder` with the standard
   *     commit so lifecycle events fire.
   *   - When `paneId` is not the deck's active stack, flip the stack's
   *     active-in-stack card with a raw mutation — no lifecycle events,
   *     no first-responder change. Subscribers that need to react to
   *     active-in-pane changes on inactive panes must subscribe to
   *     deck-state notifications directly (`deckManager.subscribe`)
   *     and diff `pane.activeCardId` themselves; the card-lifecycle
   *     channel is silent on this path.
   */
  private _setActiveCardInPane(paneId: string, cardId: string): void {
    const win = this.deckState.panes.find((s) => s.id === paneId);
    if (!win) return;
    if (!win.cardIds.includes(cardId)) return;
    if (win.activeCardId === cardId) return;

    if (paneId === this.deckState.activePaneId) {
      // Reached only when win.activeCardId !== cardId (guarded above),
      // so the composite bit is guaranteed to change — the helper's
      // same-bit branch is unreachable from here.
      this._flipFirstResponder(
        cardId,
        () => this._commitStandardFirstResponderFlip(cardId),
        "_setActiveCardInPane",
      );
      return;
    }

    const updatedStack: TugPaneState = { ...win, activeCardId: cardId };
    this.deckState = {
      ...this.deckState,
      panes: this.deckState.panes.map((s) => (s.id === paneId ? updatedStack : s)),
    };
    this.notify("_setActiveCardInPane");
    this.scheduleSave();
  }

  /**
   * Reorder a card within its stack.
   */
  private _reorderCardInPane(paneId: string, fromIndex: number, toIndex: number): void {
    const win = this.deckState.panes.find((s) => s.id === paneId);
    if (!win) return;

    const len = win.cardIds.length;
    if (fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len) return;
    if (fromIndex === toIndex) return;

    const newCardIds = [...win.cardIds];
    const [moved] = newCardIds.splice(fromIndex, 1);
    newCardIds.splice(toIndex, 0, moved);

    const updatedStack: TugPaneState = { ...win, cardIds: newCardIds };
    this.deckState = {
      ...this.deckState,
      panes: this.deckState.panes.map((s) => (s.id === paneId ? updatedStack : s)),
    };
    this.notify("_reorderCardInPane");
    this.scheduleSave();
  }

  /**
   * Detach a card from its source stack into a new single-card stack at the
   * clamped position. If the source stack becomes empty, close it (via
   * `_closePane`). Returns the new stack's id.
   *
   * Unlike the pre-Card/CardStack implementation, card identity is preserved:
   * the card object moves from the source stack's `cardIds` into the new
   * stack's `cardIds`. Tugcast sessions, portal DOM, and React state survive.
   *
   * **Fresh-bag invariant.** The card's save callback is invoked before the
   * commit so the per-card `CardStateBag` (scroll, selection, content
   * payload) reflects the card's live pre-move values. `CardHost`'s
   * `useCardContentRestore` re-fires on `hostStackId` change and will
   * re-apply the bag against the new pane's content element — re-applying a
   * stale bag would overwrite live scroll position with values from before
   * the user's most recent interaction, violating [L23]. Flushing here
   * closes the debounce window between the last edit and the move.
   */
  private _detachCard(
    paneId: string,
    cardId: string,
    position: { x: number; y: number },
  ): string | null {
    const win = this.deckState.panes.find((s) => s.id === paneId);
    if (!win) return null;
    if (!win.cardIds.includes(cardId)) return null;

    // Last-card guard: cannot detach the only card (that's just moving the
    // stack, not detaching).
    if (win.cardIds.length === 1) return null;

    // Fresh-bag invariant: see method docstring. The `"manual"` tag
    // on the save-callback trace event distinguishes this pre-move
    // flush from the close-handoff flush that destruction paths fire.
    this.invokeSaveCallback(cardId, "manual");

    const card = this.deckState.cards.find((c) => c.id === cardId);
    if (!card) return null;

    const sizePolicy = getSizePolicy(card.componentId);

    const TITLE_BAR_VISIBLE_MIN_X = 100;
    const TITLE_BAR_HEIGHT = 36;
    const canvasWidth = this.container.clientWidth || 800;
    const canvasHeight = this.container.clientHeight || 600;
    const clampedX = Math.max(
      -(sizePolicy.preferred.width - TITLE_BAR_VISIBLE_MIN_X),
      Math.min(position.x, canvasWidth - TITLE_BAR_VISIBLE_MIN_X),
    );
    const clampedY = Math.max(0, Math.min(position.y, canvasHeight - TITLE_BAR_HEIGHT));

    const newPaneId = crypto.randomUUID();
    const newStack: TugPaneState = {
      id: newPaneId,
      position: { x: clampedX, y: clampedY },
      size: { width: sizePolicy.preferred.width, height: sizePolicy.preferred.height },
      cardIds: [cardId],
      activeCardId: cardId,
      title: "",
      acceptsFamilies: win.acceptsFamilies,
    };

    // Source keeps at least one card (last-card guard above), so
    // `spliced.activeCardId` is guaranteed non-null here.
    const spliced = spliceCardFromStack(win, cardId);
    const updatedSourceStack: TugPaneState = {
      ...win,
      cardIds: spliced.cardIds,
      activeCardId: spliced.activeCardId as string,
    };

    // Single-commit flip: insert new pane + patch source + move
    // `activePaneId` to the new pane, all in one notify. The helper
    // reads `oldFR` before commit, so transition 6 (cardId was
    // already FR → same-bit, no events) and transition 6b (cardId
    // was not FR → full flip) are distinguished correctly. Card
    // identity is preserved across the detach, so no construction
    // event fires. The flip is wrapped in `flushSync` so React's
    // portal reconciliation commits the re-parent synchronously —
    // `transferFocusAfterMove` below then resolves against the
    // post-commit DOM (see `_moveCardToPane` for the full rationale).
    flushSync(() => {
      this._flipFirstResponder(
        cardId,
        () => {
          this.deckState = {
            ...this.deckState,
            panes: [
              ...this.deckState.panes.map((s) =>
                s.id === paneId ? updatedSourceStack : s,
              ),
              newStack,
            ],
            activePaneId: newPaneId,
          };
          this.notify("_detachCard");
          this.scheduleSave();
          this.putFocusedCardIdGuarded(cardId);
        },
        "_detachCard",
      );
    });

    // Refocus after the move. The flip above flushed synchronously,
    // so the detached card's CardHost is now re-parented under the
    // new pane via React's portal reconciliation and its registered
    // host root points at the post-commit DOM. The drag-start save
    // (`captureFocusForDragStart`) preserved `bag.focus` +
    // `bag.domSelection` while the input was still focused, so the
    // helper resolves the saved snapshot and restores focus inside
    // the moved card. When `bag.focus` is absent (or `kind: "none"`),
    // `resolveBagFocus` falls through to the default-focus path so
    // the card still receives the caret.
    transferFocusAfterMove({ sourceCardId: cardId, store: this });

    return newPaneId;
  }

  /**
   * Move a card from its source stack to a target stack at `insertAtIndex`.
   *
   * Card identity is preserved. If the source stack becomes empty (it had
   * only this card), the source stack is closed.
   *
   * **Fresh-bag invariant.** The card's save callback is invoked before the
   * commit so the per-card `CardStateBag` (scroll, selection, content
   * payload) reflects the card's live pre-move values. `CardHost`'s
   * `useCardContentRestore` re-fires on `hostStackId` change and will
   * re-apply the bag against the target pane's content element —
   * re-applying a stale bag would overwrite live scroll position with
   * values from before the user's most recent interaction, violating
   * [L23]. Flushing here closes the debounce window between the last edit
   * and the move.
   */
  private _moveCardToPane(
    sourcePaneId: string,
    cardId: string,
    targetPaneId: string,
    insertAtIndex: number,
  ): void {
    if (sourcePaneId === targetPaneId) return;

    const sourceStack = this.deckState.panes.find((s) => s.id === sourcePaneId);
    if (!sourceStack || !sourceStack.cardIds.includes(cardId)) return;

    const targetStack = this.deckState.panes.find((s) => s.id === targetPaneId);
    if (!targetStack) return;

    // Fresh-bag invariant: see method docstring. `"manual"` tag per
    // the pre-move flush convention shared with `_detachCard`.
    this.invokeSaveCallback(cardId, "manual");

    // Post-move `activePaneId`: always shift to the target. Cross-
    // pane move is exclusively driven by the user's drag gesture
    // (the only production caller is `cardDragCoordinator.onPointerUp`
    // committing a "merge"-mode drop), and the user's intent in
    // dragging a card to another pane is to follow the card —
    // attention moves with the gesture. Previously the target
    // only became active when the source was destroyed, which left
    // the dragged card mounted but not focused; users had to click
    // back into it to resume work. Always activating the target
    // closes that gap and lets `transferFocusAfterMove` resolve
    // a focus-destination card on the post-commit DOM.
    const postMoveActivePaneId = targetPaneId;

    const spliced = spliceCardFromStack(sourceStack, cardId);

    // Composite first-responder bit: the moved card is the active
    // card of the active pane post-move, so it becomes FR
    // unconditionally.
    const newFR: string = cardId;

    // Transition 7: flip composite bit. Card identity is preserved
    // across the move, so no destruction event. The flip is wrapped
    // in `flushSync` so React's portal reconciliation (unmount the
    // card's CardHost from the source pane, re-mount it under the
    // target pane) commits synchronously — by the time
    // `transferFocusAfterMove` runs below, the card's DOM is in its
    // post-commit location and the resolver finds the live target.
    // Without the flush, `transferFocusAfterMove` resolves against
    // the pre-move DOM, claims (or yields to) the about-to-be-
    // destroyed source-pane element, and the re-mount then drops
    // focus to body with nothing left to re-claim it.
    flushSync(() => {
      this._flipFirstResponder(
        newFR,
        () => {
          let intermediateStacks: readonly TugPaneState[] = this.deckState.panes;
          if (spliced.activeCardId === null) {
            intermediateStacks = intermediateStacks.filter(
              (s) => s.id !== sourcePaneId,
            );
          } else {
            const updatedSourceStack: TugPaneState = {
              ...sourceStack,
              cardIds: spliced.cardIds,
              activeCardId: spliced.activeCardId,
            };
            intermediateStacks = intermediateStacks.map((s) =>
              s.id === sourcePaneId ? updatedSourceStack : s,
            );
          }

          const clampedIndex = Math.max(
            0,
            Math.min(insertAtIndex, targetStack.cardIds.length),
          );
          const newTargetCardIds = [...targetStack.cardIds];
          newTargetCardIds.splice(clampedIndex, 0, cardId);
          const updatedTargetStack: TugPaneState = {
            ...targetStack,
            cardIds: newTargetCardIds,
            activeCardId: cardId,
          };

          // Bump the target pane to the end of the panes array (z-
          // top). Mirrors `_commitStandardFirstResponderFlip` — the
          // deck's "focused card" is read as the activeCardId of the
          // last (top-most) pane, so the target needs to be at the
          // end for the moved card to be observable as the FR.
          const withoutTarget = intermediateStacks.filter(
            (s) => s.id !== targetPaneId,
          );
          const finalStacks: readonly TugPaneState[] = [
            ...withoutTarget,
            updatedTargetStack,
          ];

          this.deckState = {
            ...this.deckState,
            panes: finalStacks,
            activePaneId: postMoveActivePaneId,
          };
          this.notify("_moveCardToPane");
          this.scheduleSave();
          this.putFocusedCardIdGuarded(newFR);
        },
        "_moveCardToPane",
      );
    });

    // Refocus after the move — the flip above flushed synchronously,
    // so the card's CardHost is now re-parented under the target
    // pane and its registered host root points at the post-commit
    // DOM. See the matching comment in _detachCard for the L23 /
    // drag-start-save contract.
    transferFocusAfterMove({ sourceCardId: cardId, store: this });
  }

  // ---- Content width ----

  /**
   * Set one content pane's width to a named preset, and stamp which preset put
   * it there.
   *
   * Width goes through `movePane` like any other resize — the pane's geometry
   * is the pane's, and a preset is a *source* for a width rather than a second
   * kind of width. Two consequences follow from that, and both are deliberate:
   *
   *  - **The move keeps the pane's slot.** `movePane` is called with no opts,
   *    which is the shape that leaves `slot` alone; a preset is not a gesture
   *    that means "leave the arrangement".
   *  - **The preset is held between the pane's bounds.** `movePane` does not
   *    clamp, and a stack's policy can beat a preset in either direction
   *    (Settings' 720 floor beats slim; About is locked at 320), so the clamp
   *    happens here. The stamp still records what the user chose: the check
   *    belongs on the row they picked, and the width they got is as close to it
   *    as the card allows.
   *
   * A sidebar pane is refused outright — a rail's width is the allocator's
   * unknown, and a preset there would be overwritten by the next solve.
   */
  private _setPaneWidth(paneId: string, preset: ContentWidth): void {
    const pane = this.deckState.panes.find((p) => p.id === paneId);
    if (!pane) return;
    if (this._sidebarComponentIdOfPane(paneId) !== undefined) {
      console.warn(
        `setPaneWidth: pane "${paneId}" hosts a sidebar card; rails take their width from the allocator`,
      );
      return;
    }

    const policy = getStackSizePolicy(this._componentIdsOfPane(pane));
    const width = resolveContentWidthPx(
      preset,
      policy.min.width,
      policy.max?.width,
    );
    this.movePane(
      paneId,
      pane.position,
      { width, height: pane.size.height },
      { widthPreset: preset },
    );
  }

  /** The componentIds a pane's stack is made of, in card order. */
  private _componentIdsOfPane(pane: TugPaneState): string[] {
    const cardsById = new Map(this.deckState.cards.map((c) => [c.id, c]));
    return pane.cardIds
      .map((cid) => cardsById.get(cid)?.componentId)
      .filter((id): id is string => id !== undefined);
  }

  /**
   * Set the deck's default content width and put every content pane on it.
   *
   * The default is a deck-wide statement rather than a seed for the next card:
   * choosing a width in the Layouts section is saying "this is how wide content
   * reads here", so it reaches the panes already open and overwrites whatever
   * per-pane widths the title-bar popup had set. Dissent runs the other way —
   * you pick the deck's width first, then narrow the one card you want narrow.
   *
   * Choosing the width the deck is already at is therefore not a no-op: it is
   * the gesture that puts a deviating pane back, the same reasoning that keeps
   * `setSidebarSide` from short-circuiting on an unchanged side.
   *
   * Sidebar panes are not content and are skipped — a rail's width belongs to
   * the allocator ([P04]), which runs in the same commit: restamping the
   * content panes moves every seam in the chain, and a width row is a Layouts
   * click, one of the two moments the deck is licensed to re-arrange itself.
   * Leaving the rails tuned for the old card widths was how picking a width
   * could open gaps at every seam and stand there.
   *
   * ONE COMMIT, deliberately — the widths, the record, and the rails together,
   * rather than a notify per pane. The settle is FLIP: `settle-engine.ts` reads
   * where the frames are on the store event and where they landed after the
   * commit React makes of it, so a gesture that notifies once per pane offers
   * that measurement a half-changed deck each time and re-arms the window on
   * every one of them. The panes are resized here rather than through
   * `_setPaneWidth` for exactly that reason; the clamp and the stamp are the
   * same as that path's, because both take them from `resolveContentWidthPx`.
   */
  setContentWidth(preset: ContentWidth): void {
    const panes = this.deckState.panes.map((pane) => {
      if (this._sidebarComponentIdOfPane(pane.id) !== undefined) return pane;
      const policy = getStackSizePolicy(this._componentIdsOfPane(pane));
      const width = resolveContentWidthPx(
        preset,
        policy.min.width,
        policy.max?.width,
      );
      return {
        ...pane,
        size: { ...pane.size, width },
        widthPreset: preset,
      };
    });
    // A deck-wide width statement re-widths every content pane, so it ends the
    // bullseye of whichever pane holds it. Honored explicitly because this
    // path builds its pane array inline and hands it to `_commitImposition`,
    // bypassing `movePane` — deliberately, so the settle measures once.
    for (const pane of panes) this._clearBullseyeFor(pane.id);
    this._commitImposition(
      { ...this.deckState.imposition, contentWidth: preset },
      panes,
    );
  }

  /**
   * Put the panes hosting `cardIds` on a named width, in one commit.
   *
   * The card-addressed sibling of {@link setContentWidth}: same clamp, same
   * stamp, same one-commit discipline — but it reaches only the panes named,
   * and it does NOT move the deck's default. Choosing a width for a selection
   * is a statement about those cards, not about how content reads here.
   *
   * Sidebar panes among the ids are skipped rather than refused: a rail's width
   * belongs to the allocator, and dropping it from the batch is what lets a
   * width chord work on a mixed selection instead of dying on it.
   *
   * And the rails are left ALONE — `retuneRails: false`, unlike every other
   * caller of `_commitImposition`. That is the difference between this verb and
   * `setContentWidth`: choosing the deck's content width is a Layout-card click,
   * one of the moments the deck is licensed to re-arrange itself, while sizing
   * the card you are looking at is not. Re-solving here shrank the rail to its
   * floor on an ordinary ⌃⌘-digit, which is the user's rail spent on a gesture
   * that never mentioned it.
   */
  setCardWidths(cardIds: readonly string[], preset: ContentWidth): void {
    if (cardIds.length === 0) return;
    const wanted = new Set(cardIds);
    const targetPaneIds = new Set(
      this.deckState.panes
        .filter(
          (pane) =>
            pane.cardIds.some((cid) => wanted.has(cid)) &&
            this._sidebarComponentIdOfPane(pane.id) === undefined,
        )
        .map((pane) => pane.id),
    );
    if (targetPaneIds.size === 0) return;

    const panes = this.deckState.panes.map((pane) => {
      if (!targetPaneIds.has(pane.id)) return pane;
      const policy = getStackSizePolicy(this._componentIdsOfPane(pane));
      const width = resolveContentWidthPx(
        preset,
        policy.min.width,
        policy.max?.width,
      );
      return { ...pane, size: { ...pane.size, width }, widthPreset: preset };
    });
    // Re-widthing ends the pane's bullseye, honored explicitly because this
    // path builds its pane array inline and hands it to `_commitImposition`,
    // bypassing `movePane` — deliberately, so the settle measures once.
    for (const paneId of targetPaneIds) this._clearBullseyeFor(paneId);
    this._commitImposition(this.deckState.imposition, panes, {
      retuneRails: false,
    });
  }

  // ---- Fold (`fold.ts`) ----

  /**
   * What the fold gesture reaches on this manager: the imposition deps —
   * so its bullseye clear is the same `_clearBullseyeFor` forwarder — plus
   * the rail lookup, the wall reveal, and the gesture stamp.
   */
  private readonly foldDeps: FoldDeps = {
    ...this.impositionDeps,
    sidebarComponentIdOfPane: (paneId) => this._sidebarComponentIdOfPane(paneId),
    wallRevealFor: (paneId, panes, slot) => this._wallRevealFor(paneId, panes, slot),
    stampGesture: (at) => {
      this.impositionGestureAt = at;
    },
  };

  /** Fold or show one content pane — see `fold.setPaneFolded`. */
  setPaneFolded(paneId: string, folded: boolean): void {
    fold.setPaneFolded(this.foldDeps, paneId, folded);
  }

  /** The card-addressed twin of {@link setPaneFolded} — see `fold.setCardFolded`. */
  setCardFolded(cardId: string, folded: boolean): void {
    fold.setCardFolded(this.foldDeps, cardId, folded);
  }

  // ---- Layout Persistence ----

  /**
   * Record the focused card on the ACTIVE SPACE and schedule a save.
   *
   * From layout v5 the focused card rides its space rather than a standalone
   * `dev.tugapp.deck.state` row ([P02]): one workspace per focused card is the
   * only shape that can answer "where was I in THIS workspace", and a single
   * global row could not. There is no tugbank write of its own to guard —
   * `scheduleSave` goes through `LayoutPersistence.putLayoutGuarded`, which carries the
   * test-mode bypass and the `__tugPersistInTestMode` escape hatch for the
   * cold-boot harness tests ([D02]).
   *
   * Still a named wrapper rather than two lines at each of its call sites: it
   * is one write family with many callers, and the ones that matter are the
   * responder flips, which have no other reason to know about spaces.
   */
  private putFocusedCardIdGuarded(focusedCardId: string): void {
    if (this.spacesStore.setActiveFocusedCard(focusedCardId)) this.scheduleSave();
  }

  /**
   * Seed {@link spacesStore} from the boot layout and
   * return the ACTIVE space's deck — which the constructor assigns to
   * {@link deckState}. The parse lives in `loadBootLayout`; what it found is
   * applied here, where the spaces live.
   */
  private loadLayout(): DeckState {
    const boot = loadBootLayout({
      initialLayout: this.initialLayout,
      canvasWidth: this.container.clientWidth || 800,
      canvasHeight: this.container.clientHeight || 600,
      initialTheme: this.initialTheme,
      fallbackTheme: this.fallbackTheme,
      filterRegisteredCards: (state) => this.filterRegisteredCards(state),
    });
    this.initialLayout = null;
    if (boot.fresh) this.factoryFresh = this.bootStateHonored;
    this.spacesStore.seed(boot.spaces, boot.activeSpaceId);
    return boot.deck;
  }

  /**
   * Every space as a persistable record, with the active one's `deck` taken
   * from the live {@link deckState} — the one place it lives.
   */
  private spacesState(): SpacesState {
    return this.spacesStore.persistable(this.deckState);
  }

  private saveLayout(): Promise<boolean> {
    return this.persistence.saveLayout();
  }

  private scheduleSave(): void {
    if (this.batchDepth > 0) {
      // Held with the notify, and re-armed once on the way out — the
      // gesture's final state is the only one worth persisting.
      this.batchPendingSave = true;
      return;
    }
    this.persistence.scheduleSave();
  }

  /**
   * Filter out cards whose componentIds are not registered and, as a result,
   * any stacks that lose all their cards.
   *
   * For each card: if `componentId` is not registered, drop the card.
   * For each stack: if all its cardIds now point to dropped cards, drop the
   * stack. Otherwise rewrite `cardIds` to reference only remaining cards and
   * fall `activeCardId` back to the first surviving card id.
   */
  private filterRegisteredCards(state: DeckState): DeckState {
    return filterDeckStateByRegistration(
      state,
      (componentId) => getRegistration(componentId) !== undefined,
    );
  }

  destroy(): void {
    this.persistence.dispose();
    this.cardStates.dispose();

    if (this.reactRoot) {
      this.reactRoot.unmount();
      this.reactRoot = null;
    }
    this.destroyed = true;
    // A deferred notify still in flight would tell every subscriber left in
    // the set about a store that no longer exists, so release it ([L27]).
    this.deferredNotify?.cancel();
    this.deferredNotify = null;
    this.switchMark.release();
    for (const watch of [...this.arrivalWatches.values()]) watch.dispose();
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("beforeunload", this.handleBeforeUnload);
    this.containerSizeObserver?.disconnect();
    window.removeEventListener("resize", this.dropContainerSize);
    this.lifecycleCascade.dispose();
  }
}
