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

import {
  type DeckState,
  type CardState,
  type TugPaneState,
  type CardStateBag,
  validateDeckState,
  clampPanesToDeck,
} from "./layout-tree";
import { buildDefaultLayout, serialize, deserialize } from "./serialization";
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
import { CARDS_CARD_ID } from "./lib/cards-card-id";
import {
  bullseyePaneIdOf,
  columnMoveOrder,
  deckColumnsOf,
  deckFlowStrip,
  findSidebarPanes,
  paneRenderWidthOf,
} from "./deck-store-selectors";
import { getTugbankClient } from "./lib/tugbank-singleton";
import { sidebarWidthStore } from "./lib/sidebar-width-store";
import { publishFlowOffset } from "./lib/imposer-gauges";
import { TugConnection } from "./connection";
import React from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { DeckCanvas } from "./components/chrome/deck-canvas";
import { ConfigureTug } from "./components/tugways/configure-tug";
import { TugLogout } from "./components/tugways/tug-logout";
import { ConfigureTugRequest } from "./components/tugways/configure-tug-request";
import { TugVersionGate } from "./components/tugways/tug-version-gate";
import { TugRestoreGate } from "./components/tugways/tug-restore-gate";
import { ErrorBoundary } from "./components/chrome/error-boundary";
import { TugBannerProvider } from "./components/chrome/tug-banner-bridge";
import { RateLimitBulletinBridge } from "./components/chrome/rate-limit-bulletin-bridge";
import { RateLimitStore } from "./lib/rate-limit-store";
import { UsageStore } from "./lib/usage-store";
import { UsageContext } from "./lib/usage-context";
import { ResponderChainProvider } from "./components/tugways/responder-chain-provider";
import { TugTooltipProvider } from "./components/tugways/tug-tooltip";
import { TugAlertProvider } from "./components/tugways/tug-alert";
import { TugBulletinProvider } from "./components/tugways/tug-bulletin";
import { putLayout, putCardState, putFocusedCardId } from "./settings-api";
import { flushPromptHistorySync } from "./lib/prompt-history-api";
import { TugThemeProvider, type ThemeName } from "./contexts/theme-provider";
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
  sidebarSide,
  railHiddenMembers,
  withRailHidden,
  isSidebarSide,
  clampFlowOffset,
  clampStripOffset,
  columnModeOf,
  placeStanding,
  PLACE_OVERFLOW_VISIBLE_MEMBERS,
  effectiveRailOrder,
  firstVisibleFlowSlot,
  flowRevealOffset,
  impositionLayout,
  FLOW_OFFSET_PROPERTY,
  impositionGapBottomPx,
  IMPOSITION_GAP_PX,
  stripRevealOffset,
  railModeOf,
  withRailMode,
  withRailOrder,
  withColumnMode,
  sweptColumnOrders,
  withColumnOrder,
  withColumnShares,
  withoutColumnShares,
  withRailShares,
  withoutRailShares,
  CONTENT_WIDTH_SLIM_PX,
  DEFAULT_CONTENT_WIDTH,
  DEFAULT_IMPOSITION_KIND,
  DEFAULT_SIDEBAR_SIDE,
  withSidebarPinned,
  withSidebarSide,
  resolveContentWidthPx,
  vacancyExtent,
  type ContentWidth,
  type DeckImposition,
  type ImpositionKind,
  type ColumnMode,
  type ImpositionLayout,
  type ColumnMoveTarget,
  type RailMode,
  type RailPolicy,
  type RailWidths,
  type SidebarSide,
} from "./lib/layout-imposer";
import { getTugZoom } from "./components/tugways/scale-timing";
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
import { ComponentStatePreservationRegistry } from "./components/tugways/component-state-preservation-registry";
import {
  CardStateOrchestrator,
  type CardAssembler,
} from "./card-state-orchestrator";
import { deckTrace, type SaveCallbackSource } from "./deck-trace";
import { cardServicesStore } from "./lib/card-services-store";
import type { CodeSessionStore } from "./lib/code-session-store";
import {
  reactivateCurrentFocusDestination,
  transferFocusAfterMove,
  transferFocusForActivation,
} from "./focus-transfer";

/** Debounce delay for saving layout (ms) */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Outcome of one card-state write attempt, reported by
 * `flushDirtyCardStates` so teardown-class callers can retry the
 * failures and name the survivors instead of assuming success.
 */
export interface CardFlushResult {
  cardId: string;
  ok: boolean;
}

/** What one run of the teardown-save core actually persisted. */
export interface TeardownSaveResult {
  layoutSaved: boolean;
  cards: CardFlushResult[];
}

/**
 * What the deck actually managed to do before the host tore the process
 * down — the resolved value of {@link DeckManager.prepareForTermination},
 * returned across the bridge and logged verbatim by the host.
 *
 * `ok: false` never blocks or delays the quit; it makes the failure named
 * instead of silent, which is the whole point of the pipeline.
 */
/**
 * Whether a slot arrangement took.
 *
 * `assignCardsToSlots` refuses the whole batch rather than half-applying it,
 * so the caller needs to hear which of the two happened before it decides
 * whether to show a receipt or a refusal. `blockedCardId` is present when the
 * refusal has a member to blame — a slot outside the arrangement — and absent
 * when the batch never had a subject at all (no imposition, no such card, a
 * sidebar host), which is a programming fault rather than an edge the user
 * pressed into.
 */
export type SlotAssignment =
  | { readonly ok: true }
  | { readonly ok: false; readonly blockedCardId?: string };

export interface TerminationVerdict {
  /** True when every phase below came back clean. */
  ok: boolean;
  /** `tug_session_id`s interrupted and observed to settle. */
  interrupted: string[];
  /** Interrupt sent, but the session had not settled when the bound expired. */
  unacknowledged: string[];
  /** Card bags written and confirmed by tugbank. */
  flushedCards: number;
  /** Card ids whose writes still failed after the retry budget. */
  failedCards: string[];
  layoutSaved: boolean;
  elapsedMs: number;
}

/**
 * How long the termination pipeline waits for interrupted sessions to
 * settle. Sized to contain tugcode's own ladder — a 2 s in-band ack grace
 * plus a 1.5 s SIGINT grace — with margin. A session that has not settled
 * by then is reported unacknowledged and the quit proceeds ([P04]: a quit
 * may be slow, never hung).
 */
const TERMINATION_INTERRUPT_AWAIT_MS = 5000;

/**
 * Total time the pipeline will spend re-attempting card-state writes that
 * tugbank rejected, and the gap between attempts. Covers the supervisor's
 * first restart-backoff steps, which is the realistic reason a write fails
 * at quit time.
 */
const TERMINATION_FLUSH_RETRY_BUDGET_MS = 5000;
const TERMINATION_FLUSH_RETRY_INTERVAL_MS = 250;

/**
 * Debounce delay for flushing dirty per-card state bags (ms). Kept
 * tighter than the layout debounce: with the 250ms dirty-pipeline
 * debounce in `use-card-dirty-state.ts` this bounds the worst-case
 * edit→durable window at ~0.5s — the most a crash or force-quit (no
 * `saveState` RPC, no `beforeunload` in WKWebView) can lose. [L23]
 */
const CARD_STATE_FLUSH_DEBOUNCE_MS = 250;

/** Cascade step between consecutive new stacks (pixels) */
const CASCADE_STEP = 30;

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
 * Drop cards whose `componentId` is not registered, and any stack left with no
 * surviving cards; rewrite each surviving stack's `cardIds` + `activeCardId`.
 *
 * Pure over `(state, isRegistered)` — the DeckManager passes `getRegistration`.
 * This is the graceful-degrade path for a retired card: a persisted blob that
 * names, e.g., the old `"changeset"` card (now a Lens section) drops that card
 * with a warn, and a stack that held only it drops too — no boot crash.
 * Returns `state` unchanged (same reference) when nothing was dropped.
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
    ...(activePaneId !== undefined
      ? { activePaneId }
      : { activePaneId: undefined }),
  };
}

/**
 * Read the DEBUG-only `__tugPersistInTestMode` flag. When `true` AND
 * `__tugTestMode` is also `true`, the test-mode persistence bypass
 * in the `put*Guarded` wrappers is skipped — writes go through.
 * Used by cold-boot harness tests that pair test-mode IPC with
 * per-test `TUGBANK_PATH` isolation. See
 * `tugapp/Sources/TestHarness/TestHarnessUserScript.swift`.
 */
function shouldPersistInTestMode(): boolean {
  return typeof window !== "undefined" && window.__tugPersistInTestMode === true;
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

  /** Debounce timer for layout saves */
  private saveTimer: number | null = null;

  // ---- Per-card state cache ([D01], [D06]) ----

  /** In-memory cache of per-card state bags. Primary read source during a session. */
  private cardStateCache: Map<string, CardStateBag> = new Map();

  /** Debounce timer for per-card state saves (separate from layout save timer). */
  private cardStateSaveTimer: number | null = null;

  /** Set of card IDs with unsaved (dirty) state bags. Used for flush-on-destroy. */
  private dirtyCardIds: Set<string> = new Set();

  /**
   * Nesting depth of active card-state-save suspensions. While > 0, the
   * debounced flush ([A9] persistence) defers — a card mid-load holds the
   * gate so the scroll / region-scroll / content churn of its settle does
   * not fire a `fetch` per dirty card on the same thread the load needs.
   * Sync (will-phase / unload) flushes bypass the gate. Released via the
   * disposer `suspendCardStateSaves` returns, which flushes once if still
   * dirty.
   */
  private cardSaveSuspendDepth = 0;

  // ---- Save callbacks for close-time state flush ([D01]) ----

  /**
   * Map of registered save callbacks keyed by card ID. Called on
   * visibilitychange (hidden) and beforeunload so each active card can
   * capture its current state before the page is discarded.
   */
  private saveCallbacks: Map<string, (source?: SaveCallbackSource) => void> = new Map();

  /**
   * Per-card Component State Preservation Protocol registries ([D13],
   * [A9]). Lazily created on first
   * `getComponentStatePreservationRegistry(cardId)` call from a child
   * component's `useComponentStatePreservation` hook; cleared when the
   * card is destroyed (`_removeCard` / `_closePane`). A card that uses
   * no opt-in components never gets an entry here.
   */
  private componentStatePreservationRegistries: Map<string, ComponentStatePreservationRegistry> =
    new Map();

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
      this.componentStatePreservationRegistries.get(cardId),
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

  private initialLayout: object | null;

  private initialTheme: ThemeName;

  // ---- Subscribable store state (useSyncExternalStore contract) ----

  private subscribers: Set<() => void> = new Set();

  private stateVersion: number = 0;

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

  public subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  };

  public getSnapshot = (): DeckState => this.deckState;

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

  public activateCard = (cardId: string): void => {
    this._flipFirstResponder(
      cardId,
      () => this._commitStandardFirstResponderFlip(cardId),
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
   * Refuses a pane that does not exist, and nothing else. A RAIL takes the
   * posture like any other pane: bullseye writes no geometry, so the rail's
   * width and side stay in the store, the band keeps the inset it was already
   * taking, and the rail drops back onto its edge on exit. Reserving the place
   * rather than reclaiming it is what keeps a bullseyed rail from reading as a
   * hidden one ([D131]).
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
   * and design decision [D02]: every `putLayout` / `putCardState` /
   * `putFocusedCardId` call site is guarded with `if (this.testMode) return;`
   * so test-mode sessions never mutate the user's persisted deck.
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
   * at all — a factory-fresh install. The factory deck stands its rail open at
   * its pin on {@link DEFAULT_SIDEBAR_SIDE}, but not until it has a card to
   * stand beside ({@link factoryRailPending}). Stays false under the
   * ordinary test-mode boot, which discards the boot state and starts empty
   * for the harness to seed.
   */
  private factoryFresh = false;

  /**
   * The factory deck's rail, waiting for the deck's first card. A brand-new
   * install opens onto the setup wizard over a bare canvas, and a rail of
   * empty cards beside it is a promise about work that does not exist yet.
   * The first card the user opens is the rail's cue to stand up beside it.
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
    options?: { testMode?: boolean },
  ) {
    this.container = container;
    this.connection = connection;
    this.rateLimitStore = new RateLimitStore(connection);
    this.usageStore = new UsageStore(connection);
    this.testMode = options?.testMode === true;
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

    if (initialCardStates && !dropBootState) {
      this.cardStateCache = new Map(initialCardStates);
    }

    this.initialFocusedCardId = dropBootState ? undefined : initialFocusedCardId;

    container.style.position = "relative";

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
          [TugThemeProvider, { initialTheme: this.initialTheme }],
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
        const save = this.batchPendingSave;
        this.batchPendingNotify = null;
        this.batchPendingSave = false;
        if (caller !== null) this.notify(caller);
        if (save) this.scheduleSave();
      }
    }
  };

  /**
   * Depth of the enclosing {@link batchGesture} calls; 0 when no gesture
   * transaction is open. `batchPendingNotify` holds the caller tag of the
   * first deferred notify (the one that opened the gesture, which is the
   * useful attribution) or `null` when nothing has asked to notify.
   */
  private batchDepth = 0;
  private batchPendingNotify: string | null = null;
  private batchPendingSave = false;

  /**
   * Fire every subscriber over the current state.
   *
   * `caller` is the mutating method's own name, stamped by each call
   * site and carried into the motion census (`deck-trace`'s
   * `store-notify` record). A gesture is supposed to cost one notify;
   * when one costs more, the census names the contributors instead of
   * reporting an anonymous count.
   */
  private notify(caller = "untagged"): void {
    if (this.batchDepth > 0) {
      // Inside a gesture transaction: record that someone wants
      // subscribers told, and let the outermost batch tell them once.
      // The first caller wins the tag — it is the mutation that opened
      // the gesture, and the census reads better naming that than the
      // incidental last one.
      this.batchPendingNotify ??= caller;
      return;
    }
    // Invariant 7, enforced rather than merely asserted: no pane commits with
    // its title bar above the deck top. Every mutation in this class lands
    // through here, so one clamp covers all of them — including the ones no
    // gesture guards (restore from a persisted layout, detach, arrange). The
    // clamp returns the same object when nothing was out of bounds, so the
    // common path costs one pass and no allocation.
    this.deckState = clampPanesToDeck(this.deckState);
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
    });
    // Host menu state rides the ordinary subscriber list: the
    // `host-menu-state` aggregator subscribes at boot (main.tsx) and
    // projects each notification into the `menuState` push the Swift
    // host validates its menus from.
    this.subscribers.forEach((cb) => cb());
  }

  refresh(): void {
    this.notify("refresh");
  }

  getDeckState(): DeckState {
    return this.getSnapshot();
  }

  sendControlFrame(action: string, params?: Record<string, unknown>): void {
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
   * `options.slot` names the slot the new card joins under a multi-slot
   * arrangement, clamped to the arrangement. Openers that have a card to open
   * *near* — a file link naming the slot beside its own — pass it; everything
   * else omits it and takes the first slot.
   */
  addCard(
    componentId: string,
    initialContent?: unknown,
    options?: { slot?: number },
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
        : this.nextCascadePosition({
            width: cappedPreferredWidth,
            height: cappedPreferredHeight,
          });

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
      this.cardStateCache.set(firstCardId, { content: initialContent });
    }
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
      // Under a multi-slot arrangement a new card joins it at a slot rather
      // than walking the cascade — the arrangement is the user's stated intent
      // for the whole deck, and a fresh card landing askew across it would be
      // the deck ignoring it. Which slot is the caller's to say (`options.slot`
      // — an opener with an originating card names the slot beside it); a card
      // arriving from nowhere takes whichever slot the deck is SHOWING
      // ({@link _openingSlot}). One-up is the
      // deck's resting state rather than a chosen arrangement, so it claims
      // nothing: a new card cascades as it always did and takes the single slot
      // only by being put there. Centered dialog cards stay centered under
      // every kind; they are not part of the arrangement.
      ...(slotCount(this.deckState.imposition.kind ?? DEFAULT_IMPOSITION_KIND) > 1 &&
      registration.placement !== "center"
        ? {
            slot: clampSlot(
              this.deckState.imposition.kind ?? DEFAULT_IMPOSITION_KIND,
              options?.slot ?? this._openingSlot(),
            ),
          }
        : {}),
    };

    // Single-commit flip (transition 4). `_flipFirstResponder` reads
    // `oldFR` internally BEFORE running the commit, so it fires the
    // correct deactivate pair even though the commit puts
    // `activePaneId = paneId` (which would make a post-commit
    // state-derived read return `firstCardId`).
    this._flipFirstResponder(
      firstCardId,
      () => {
        this.deckState = {
          ...this.deckState,
          cards: [...this.deckState.cards, ...seededCards],
          panes: [...this.deckState.panes, win],
          activePaneId: paneId,
        };
        this.notify("addCard");
        this.scheduleSave();
        for (const c of seededCards) {
          this.cardLifecycle.notifyCardDidFinishConstruction(c.id);
        }
        this.putFocusedCardIdGuarded(firstCardId);
      },
      "addCard",
    );

    return firstCardId;
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
   * pinned Lens can never be standing.
   *
   * A pane whose geometry is DERIVED is left alone: a slotted pane is placed
   * by the imposer and the Lens by its pin, so writing a stored position for
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
      this.activateCard(existing.id);
      return existing.id;
    }
    return this._createSidebarPane(componentId);
  }

  /** Hide a sidebar card by closing its pane. No-op when it is not open. */
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
   * Show `side`'s rail: reopen the members it held when it was last hidden
   * whole, or — with no such memory — the one card that belongs there.
   * Returns the card id of the member left z-frontmost, or `null` when the
   * side has nothing to show.
   *
   * The memory is z-ordered, back to front ({@link RailArrangement.hidden}),
   * and the panes are reopened in that order, so the member that was in front
   * when the rail went away is in front when it comes back. Vertical order is
   * not this method's business at all: it lives in the side's `order` and
   * survives the round trip untouched.
   *
   * Consuming the memory is part of showing. A record left standing would be
   * re-read by the next show, and by then it describes a rail the user has
   * since rearranged.
   */
  showSidebarRail(side: SidebarSide): string | null {
    const remembered = railHiddenMembers(
      this.deckState.imposition,
      side,
    ).filter((componentId) => isSidebarCard(componentId));
    const opening =
      remembered.length > 0 ? remembered : this._defaultRailMembers(side);
    let frontmost: string | null = null;
    for (const componentId of opening) {
      const cardId = this.showSidebarPane(componentId);
      if (cardId !== null) frontmost = cardId;
    }
    if (remembered.length > 0) {
      this._reimpose(withRailHidden(this.deckState.imposition, side, []));
    }
    return frontmost;
  }

  /**
   * Hide `side`'s rail: record which members were standing on it and close
   * every one of them.
   *
   * The record is written BEFORE the closes, in its own commit, because each
   * close rewrites the imposition — writing it after would be writing it onto
   * a deck the closes had already moved on from.
   */
  hideSidebarRail(side: SidebarSide): void {
    const members = this._railMembersInZOrder(side);
    if (members.length === 0) return;
    this._reimpose(withRailHidden(this.deckState.imposition, side, members));
    for (const componentId of members) this.hideSidebarPane(componentId);
  }

  /** The sidebar componentIds standing pinned on `side`, back to front — the
   *  panes array's own order, which is the deck's z-order. */
  private _railMembersInZOrder(side: SidebarSide): readonly string[] {
    const imposition = this.deckState.imposition;
    return findSidebarPanes(this.deckState)
      .filter(
        ({ componentId }) =>
          isSidebarPinned(imposition, componentId) &&
          sidebarSide(imposition, componentId) === side,
      )
      .map(({ componentId }) => componentId);
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
   * floating Lens already records "right" is a request to put it back.
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
        .filter(({ componentId }) => isSidebarPinned(imposition, componentId))
        .map(({ componentId }) => componentId),
    );
    const registered = [...getAllRegistrations().keys()].filter((componentId) =>
      standing.has(componentId),
    );
    return effectiveRailOrder(imposition, side, registered);
  }

  /**
   * Stack or split `side`'s rail — the one gesture that changes what a shared
   * rail *is*, reached from the stack badge and the Lens's Layout section.
   *
   * Splitting materializes the side's `order` in the same imposition, so a
   * split rail's vertical order is stored state from the first frame rather
   * than a fallback a later click could move ([R06]). One commit carrying both
   * fields, never two: the split arms exactly one settle.
   *
   * Re-stacking keeps order and shares. They are harmless to a stack — every
   * member draws the same rect — and they are what the user arranged, so a
   * re-split lands where they left it rather than on a default.
   */
  setRailMode(side: SidebarSide, mode: RailMode): void {
    const imposition = this.deckState.imposition;
    if (railModeOf(imposition, side) === mode) return;
    const next = withRailMode(imposition, side, mode);
    this._reimpose(
      mode === "split"
        ? withRailOrder(next, side, this._railOrder(imposition, side))
        : next,
    );
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
   * Set `side`'s height weights — the seam drag's commit. Weights that are not
   * positive finite numbers are dropped rather than stored: an unnamed member
   * already weighs 1, so a dropped weight means exactly what a missing one
   * does, and nothing downstream has to defend against a `NaN` height.
   */
  setRailShares(side: SidebarSide, shares: Record<string, number>): void {
    const weights: Record<string, number> = {};
    for (const [componentId, weight] of Object.entries(shares)) {
      if (!isSidebarCard(componentId)) continue;
      if (typeof weight !== "number") continue;
      if (!Number.isFinite(weight) || weight <= 0) continue;
      weights[componentId] = weight;
    }
    this._reimpose(withRailShares(this.deckState.imposition, side, weights));
  }

  /** Divide `side`'s run equally again, keeping its mode and order — what the
   *  badge's "Equalize Heights" and a double-click on a seam ask for. */
  equalizeRail(side: SidebarSide): void {
    const imposition = this.deckState.imposition;
    const equalized = withoutRailShares(imposition, side);
    if (equalized === imposition) return;
    this._reimpose(equalized);
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
    return (
      deckColumnsOf(this.deckState).find((column) => column.slot === slot)
        ?.members ?? []
    );
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
   * Stack or split `slot`'s column — the content-side twin of
   * {@link setRailMode}, reached from the stack badge, the Lens's Layouts
   * section, and ⌃⌘S.
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
   * are not positive finite numbers are dropped rather than stored, exactly as
   * {@link setRailShares} drops them: an unnamed member already weighs 1.
   */
  setColumnShares(slot: number, shares: Record<string, number>): void {
    const standing = new Set(
      this.deckState.panes.filter((p) => p.slot === slot).map((p) => p.id),
    );
    const weights: Record<string, number> = {};
    for (const [paneId, weight] of Object.entries(shares)) {
      if (!standing.has(paneId)) continue;
      if (typeof weight !== "number") continue;
      if (!Number.isFinite(weight) || weight <= 0) continue;
      weights[paneId] = weight;
    }
    this._reimpose(withColumnShares(this.deckState.imposition, slot, weights));
  }

  /** Divide `slot`'s run equally again, keeping its mode and order — what the
   *  badge's "Equalize Heights" and a double-click on a column seam ask for. */
  equalizeColumn(slot: number): void {
    const imposition = this.deckState.imposition;
    const equalized = withoutColumnShares(imposition, slot);
    if (equalized === imposition) return;
    this._reimpose(equalized);
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
      if (!isSidebarPinned(imposition, componentId)) continue;
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
       * exception: `moveInColumn` can carry a member the Lens resolved rather
       * than the one holding focus, and it is that member the user just sent
       * somewhere and now wants to see.
       */
      readonly revealPaneId?: string;
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
    const allocated = retuneRails
      ? this._allocatedRailWidths(panes, imposition)
      : null;
    const widthByPaneId = new Map<string, number>();
    if (allocated !== null) {
      for (const [side, sidePanes] of panesBySide) {
        const width = allocated[side];
        if (width === undefined) continue;
        for (const pane of sidePanes) {
          if (Math.abs(width - pane.size.width) >= 1) {
            widthByPaneId.set(pane.id, width);
          }
        }
      }
    }
    const nextPanes = panes.map((pane) => {
      const width = widthByPaneId.get(pane.id);
      return width === undefined
        ? pane
        : { ...pane, size: { ...pane.size, width } };
    });

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
    const activePaneId = opts?.revealPaneId ?? this.deckState.activePaneId;
    const flowOffset =
      activePaneId === undefined
        ? undefined
        : this._flowRevealOffsetFor(activePaneId, nextPanes, imposition);
    // The vertical half of the same re-reveal: any of these gestures can have
    // rebuilt the column under the active member — a split, a move, a card
    // leaving the slot — and the rule is minimal and idempotent here too.
    const columnReveal =
      activePaneId === undefined
        ? undefined
        : this._columnRevealOffsetFor(activePaneId, nextPanes, imposition);
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
   * in the Layouts section, a card assigned to a slot (`assignCardToSlot` —
   * the imposer's own verb, whether the Lens's slot picker or a ⌘N chord
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
    const { panesBySide } = this._sidebarRails(panes, imposition);
    if (panesBySide.size === 0) return;
    const allocated = this._allocatedRailWidths(panes, imposition);
    if (allocated === null) return;
    const moves = [...panesBySide].some(([side, sidePanes]) => {
      const width = allocated[side];
      return (
        width !== undefined &&
        sidePanes.some((pane) => Math.abs(width - pane.size.width) >= 1)
      );
    });
    if (!moves) return;
    this._commitImposition(imposition, panes);
  }

  /**
   * Commit a new imposition record, moving every pane whose geometry it
   * derives. The Lens returns to its pin through here, and the space allocator
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
    this.deckState = {
      ...this.deckState,
      imposition: withSidebarPinned(
        this.deckState.imposition,
        componentId,
        false,
      ),
      panes: this.deckState.panes.map((p) =>
        p.id === paneId ? { ...p, position: rect.position, size: rect.size } : p,
      ),
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
    this._createSidebarPane(CARDS_CARD_ID);
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
        this.deckState = {
          ...this.deckState,
          cards: [...this.deckState.cards, card],
          panes: [...this.deckState.panes, pane],
          activePaneId: paneId,
          // A sidebar that was dragged loose and then closed comes back at its
          // pin. Only a drag takes it off the pin, and closing it is not one —
          // reopening it into the middle of the deck at a nominal (0, 0) would
          // be the deck inventing a position nobody asked for.
          imposition: withSidebarPinned(
            this.deckState.imposition,
            componentId,
            true,
          ),
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
   * Close a stack by id.
   *
   * Ordering: if the closing stack contains the first responder, flip
   * the composite bit to the new top-of-deck's active card (or `null`
   * when the deck becomes empty) BEFORE firing
   * `cardWillBeginDestruction`. Then fire destruction for every card
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

    // Phase 1: flip the first responder to the new top-of-deck BEFORE
    // the destruction events. The closed stack is still in state at
    // this point — the commit just moves `activePaneId` off the
    // closing stack.
    //
    // Routed through `transferFocusForActivation` on the active-pane
    // branch. The helper
    // is only called when there is a surviving pane to receive focus
    // (`newFR !== null`); when the deck becomes empty there is no
    // incoming card to focus and the raw `_flipFirstResponder` path
    // applies.
    if (closedContainsOldFR) {
      const remainingStacks = this.deckState.panes.filter(
        (s) => s.id !== paneId,
      );
      const newTopStack =
        remainingStacks.length > 0
          ? remainingStacks[remainingStacks.length - 1]
          : null;
      const newFR = newTopStack?.activeCardId ?? null;
      const newActivePaneId = newTopStack?.id;
      const flipCommit = (): void => {
        this.deckState = {
          ...this.deckState,
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
    for (const cid of win.cardIds) {
      this.flushSaveCallbackBeforeDestruction(cid);
    }
    for (const cid of win.cardIds) {
      this.cardLifecycle.notifyCardWillBeginDestruction(cid);
    }
    const cardIdSet = new Set(win.cardIds);
    this.deckState = {
      ...this.deckState,
      cards: this.deckState.cards.filter((c) => !cardIdSet.has(c.id)),
      panes: this.deckState.panes.filter((s) => s.id !== paneId),
    };
    // Discard per-card component-state-preservation registries ([A9]) after
    // destruction notifications have fired — subscribers observing
    // destruction never have a stake in these registries, but ordering
    // after the lifecycle event makes the intent explicit.
    for (const cid of win.cardIds) {
      this.discardComponentStatePreservationRegistry(cid);
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
   * `putFocusedCardId`). For the standard promote-a-card-to-FR
   * commit, use `_commitStandardFirstResponderFlip(newFR)`.
   */
  private _flipFirstResponder(
    newFR: string | null,
    commit: () => void,
    trigger: string,
  ): void {
    const oldFR = this.getFirstResponderCardId();
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
    commit();
    if (newFR !== null) this.cardLifecycle.setResponderChainKey(newFR);
    if (oldFR !== null) this.cardLifecycle.notifyCardDidDeactivate(oldFR);
    if (newFR !== null) this.cardLifecycle.notifyCardDidActivate(newFR);
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
   */
  private _commitStandardFirstResponderFlip(newFR: string | null): void {
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
    const flowOffset = this._flowRevealOffsetFor(updatedHost.id, newStacks);
    // And the same rule down the other axis: raising a member of an
    // overflowing column slides that column's strip by the least that shows
    // it, in this commit, so the settle sees one arrangement change ([P12]).
    const columnReveal = this._columnRevealOffsetFor(updatedHost.id, newStacks);
    // And the rail's half of it: raising a member of an overflowing rail slides
    // that side's strip by the least that shows it, in this commit.
    const railReveal = this._railRevealOffsetFor(updatedHost.id, newStacks);

    this.deckState = {
      ...this.deckState,
      panes: newStacks,
      activePaneId: updatedHost.id,
      ...(flowOffset !== undefined ? { flowOffset } : {}),
      ...this._withColumnReveal(columnReveal),
      ...this._withRailReveal(railReveal),
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
    const state = { ...this.deckState, panes };
    const strip = deckFlowStrip(state);
    if (strip === null) return;
    const standing = state.flowOffset ?? 0;
    const clamped = clampFlowOffset(
      standing,
      strip.width,
      this._flowBandWidth(panes, imposition),
    );
    if (clamped === standing) return;
    this.deckState = { ...this.deckState, flowOffset: clamped };
    this.notify("_retuneFlowOffset");
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
   * Lens's drawing derive its own fit band out of nominal units — and that
   * second derivation is exactly why the plan jumped when the layout toggled.
   *
   * Public because the Lens's plan draws the committed arrangement to the real
   * proportions, and the strip alone does not say how much of it is on screen —
   * that is the band, and the band is a measurement of the canvas rather than a
   * fact in `DeckState`. Reading it here keeps the deck's one measurement in
   * one place; a second one taken off the DOM in the Lens would agree with this
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
   * The slot a card arriving from nowhere opens into: slot 0 in fit, and in
   * flow the leftmost slot the band is currently showing.
   *
   * In fit every slot is on screen, so the first one is as good an answer as
   * any and the deck has always given it. Flow is where that answer went wrong:
   * the strip is longer than the band, so slot 0 is routinely scrolled off the
   * left, and a new card took it — opening somewhere the user could not see and
   * saying nothing about it. The band is what "where the deck is" means in
   * flow, so the card opens in it.
   *
   * An explicit `options.slot` outranks this; an opener that names a slot has
   * said something about placement that a measurement should not overrule.
   */
  private _openingSlot(): number {
    const state = this.deckState;
    const strip = deckFlowStrip(state);
    if (strip === null) return 0;
    return (
      firstVisibleFlowSlot({
        strip,
        band: this._flowBandWidth(state.panes, state.imposition),
        offset: state.flowOffset ?? 0,
      }) ?? 0
    );
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
   * One run for both kinds of place. A column and a rail divide the same
   * vertical extent — `RAIL_RUN` in the imposer is the single expression both
   * sets of pins are written over — so a second measurement here would be a
   * second chance to disagree with the CSS.
   *
   * The vertical twin of {@link _flowBandWidth}, and simpler for the reason
   * the overflow pins are simpler than the share pins: nothing insets the run.
   * A rail takes width from the band; nothing takes height from the run.
   */
  private _placeRunHeight(): number {
    return (
      this.container.clientHeight - IMPOSITION_GAP_PX - impositionGapBottomPx()
    );
  }

  /**
   * The run a column's members stand in, in px, or `null` when the canvas has
   * no height to speak of.
   *
   * Public for the reason {@link getBandWidth} is: the Lens's miniature
   * draws an overflowing column as a strip behind a run, and a stored offset
   * only means something against the run it was measured in. Reading it here
   * keeps the deck's one measurement in one place.
   */
  getColumnRunHeight(): number | null {
    const run = this._placeRunHeight();
    return run > 0 ? run : null;
  }

  /** The run a rail's members stand in — {@link getColumnRunHeight}'s value
   *  under the other place's name, because the two runs are one. */
  getRailRunHeight(): number | null {
    return this.getColumnRunHeight();
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
   * The strip it measures against is a pure function of the run — every
   * overflowing member is `run / 2.5` tall by construction — so no pane is
   * measured here, which is what lets the answer be computed inside a commit
   * rather than after a layout.
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
    const column = deckColumnsOf(state).find((c) =>
      c.members.includes(paneId),
    );
    if (column === undefined || column.mode !== "split") return undefined;
    if (placeStanding(column.members.length) !== "overflow") return undefined;
    const run = this._placeRunHeight();
    if (!(run > 0)) return undefined;
    const memberHeight = run / PLACE_OVERFLOW_VISIBLE_MEMBERS;
    const index = column.members.indexOf(paneId);
    const standing = state.columnOffsets?.[column.slot] ?? 0;
    const next = stripRevealOffset({
      stripStart: index * (memberHeight + IMPOSITION_GAP_PX),
      extent: memberHeight,
      stripLength:
        column.members.length * memberHeight +
        (column.members.length - 1) * IMPOSITION_GAP_PX,
      band: run,
      offset: standing,
    });
    return next === standing ? undefined : { slot: column.slot, offset: next };
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
        ...(this.deckState.columnOffsets ?? {}),
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
    const standing = this.deckState.columnOffsets;
    if (standing === undefined) return;
    const state = { ...this.deckState, panes, imposition };
    const run = this._placeRunHeight();
    const memberHeight = run / PLACE_OVERFLOW_VISIBLE_MEMBERS;
    const columns = deckColumnsOf(state);
    const next: Record<number, number> = {};
    let changed = false;
    for (const [key, offset] of Object.entries(standing)) {
      const slot = Number(key);
      const column = columns.find((c) => c.slot === slot);
      const overflowing =
        column !== undefined &&
        column.mode === "split" &&
        placeStanding(column.members.length) === "overflow" &&
        run > 0;
      if (!overflowing) {
        changed = true;
        continue;
      }
      const clamped = clampStripOffset(
        offset,
        column.members.length * memberHeight +
          (column.members.length - 1) * IMPOSITION_GAP_PX,
        run,
      );
      if (clamped !== offset) changed = true;
      next[slot] = clamped;
    }
    if (!changed) return;
    this.deckState = {
      ...this.deckState,
      ...(Object.keys(next).length === 0
        ? { columnOffsets: undefined }
        : { columnOffsets: next }),
    };
    this.notify("_retuneColumnOffsets");
  }

  /**
   * Commit where a drag left an overflowing column's strip ([P12], Spec S03).
   *
   * ONE write, at the end of the gesture. The offset moved imperatively on its
   * custom property while the hand was down, because it is an
   * `arrangementSignature` term and a per-frame commit would arm a settle on
   * every frame — measuring and tweening the column's other members under the
   * user's hand. This is the frame where the store catches up with what the
   * deck has been showing, and it changes no geometry: CSS was already drawing
   * this number.
   *
   * Real state, not a preview, which is why a cancelled drag still commits it:
   * the card goes home, the view does not.
   */
  setColumnOffset(slot: number, offset: number): void {
    const run = this._placeRunHeight();
    if (!(run > 0)) return;
    const column = deckColumnsOf(this.deckState).find((c) => c.slot === slot);
    if (column === undefined || column.mode !== "split") return;
    if (placeStanding(column.members.length) !== "overflow") return;
    const memberHeight = run / PLACE_OVERFLOW_VISIBLE_MEMBERS;
    const clamped = clampStripOffset(
      offset,
      column.members.length * memberHeight +
        (column.members.length - 1) * IMPOSITION_GAP_PX,
      run,
    );
    const standing = this.deckState.columnOffsets?.[slot] ?? 0;
    if (clamped === standing) return;
    this.deckState = {
      ...this.deckState,
      columnOffsets: { ...this.deckState.columnOffsets, [slot]: clamped },
    };
    this.notify("setColumnOffset");
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
    if (railModeOf(arrangement, side) !== "split") return undefined;
    const order = this._railOrder(arrangement, side, panes);
    if (placeStanding(order.length) !== "overflow") return undefined;
    const index = order.indexOf(componentId);
    if (index < 0) return undefined;
    const run = this._placeRunHeight();
    if (!(run > 0)) return undefined;
    const memberHeight = run / PLACE_OVERFLOW_VISIBLE_MEMBERS;
    const standing = this.deckState.railOffsets?.[side] ?? 0;
    const next = stripRevealOffset({
      stripStart: index * (memberHeight + IMPOSITION_GAP_PX),
      extent: memberHeight,
      stripLength:
        order.length * memberHeight + (order.length - 1) * IMPOSITION_GAP_PX,
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
        ...(this.deckState.railOffsets ?? {}),
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
    const standing = this.deckState.railOffsets;
    if (standing === undefined) return;
    const run = this._placeRunHeight();
    const memberHeight = run / PLACE_OVERFLOW_VISIBLE_MEMBERS;
    const next: Partial<Record<SidebarSide, number>> = {};
    let changed = false;
    for (const [key, offset] of Object.entries(standing)) {
      const side = key as SidebarSide;
      const count = this._railOrder(imposition, side, panes).length;
      const overflowing =
        railModeOf(imposition, side) === "split" &&
        placeStanding(count) === "overflow" &&
        run > 0;
      if (!overflowing) {
        changed = true;
        continue;
      }
      const clamped = clampStripOffset(
        offset,
        count * memberHeight + (count - 1) * IMPOSITION_GAP_PX,
        run,
      );
      if (clamped !== offset) changed = true;
      next[side] = clamped;
    }
    if (!changed) return;
    this.deckState = {
      ...this.deckState,
      ...(Object.keys(next).length === 0
        ? { railOffsets: undefined }
        : { railOffsets: next }),
    };
    this.notify("_retuneRailOffsets");
  }

  /**
   * Commit where a drag left an overflowing rail's strip — the side-keyed twin
   * of {@link setColumnOffset}, and real state for the same reason: the card
   * goes home when a drag is cancelled, the view does not.
   */
  setRailOffset(side: SidebarSide, offset: number): void {
    const run = this._placeRunHeight();
    if (!(run > 0)) return;
    const imposition = this.deckState.imposition;
    if (railModeOf(imposition, side) !== "split") return;
    const count = this._railOrder(imposition, side).length;
    if (placeStanding(count) !== "overflow") return;
    const memberHeight = run / PLACE_OVERFLOW_VISIBLE_MEMBERS;
    const clamped = clampStripOffset(
      offset,
      count * memberHeight + (count - 1) * IMPOSITION_GAP_PX,
      run,
    );
    const standing = this.deckState.railOffsets?.[side] ?? 0;
    if (clamped === standing) return;
    this.deckState = {
      ...this.deckState,
      railOffsets: { ...this.deckState.railOffsets, [side]: clamped },
    };
    this.notify("setRailOffset");
  }

  /**
   * Draw the deck at `offset` without committing it — the per-frame half of a
   * flow gesture, and the one writer of it ([P11]).
   *
   * It lives on the store rather than in the canvas because the strip that
   * scrubs is in the LENS and the element the offset is written on is the
   * canvas's: a second implementation on the Lens's side would be a second
   * clamp, a second property, and a second chance to disagree. The store
   * already holds the container it measures the band off, so it is the one
   * place both gestures can reach.
   *
   * It touches no state and notifies nothing — a commit per frame would arm
   * the settle on every one of them and tween the deck under the user's hand.
   */
  previewFlowOffset(offset: number): void {
    if (deckFlowStrip(this.deckState) === null) return;
    const band = this.getBandWidth();
    if (band === null) return;
    this.container.style.setProperty(
      FLOW_OFFSET_PROPERTY,
      `${Math.round(offset)}px`,
    );
    publishFlowOffset(offset / band);
  }

  /** The flow strip's twin of {@link setColumnOffset} — the same one-write-at-
   *  the-end rule, read across instead of down. */
  setFlowOffset(offset: number): void {
    const strip = deckFlowStrip(this.deckState);
    if (strip === null) return;
    const clamped = clampFlowOffset(
      offset,
      strip.width,
      this._flowBandWidth(this.deckState.panes, this.deckState.imposition),
    );
    if (clamped === (this.deckState.flowOffset ?? 0)) return;
    this.deckState = { ...this.deckState, flowOffset: clamped };
    this.notify("setFlowOffset");
  }

  /**
   * The band the strip is seen through: the canvas, less each standing rail's
   * inset, less the chain's own gap at either end.
   *
   * The same arithmetic {@link resolveSpan} does — one gap per occupied side,
   * then one at each end of what is left — read off the standing rails rather
   * than by building `SidebarRail` records to hand that function, since a
   * rail's mode, members and seams are nothing this measurement reads.
   */
  private _flowBandWidth(
    panes: readonly TugPaneState[],
    imposition: DeckImposition,
  ): number {
    const { panesBySide } = this._sidebarRails(panes, imposition);
    const state = { ...this.deckState, panes: [...panes] };
    let inset = 0;
    for (const [, sidePanes] of panesBySide) {
      let width = 0;
      for (const pane of sidePanes) {
        width = Math.max(width, paneRenderWidthOf(state, pane));
      }
      inset += width + IMPOSITION_GAP_PX;
    }
    return this.container.clientWidth - inset - IMPOSITION_GAP_PX * 2;
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
   * sidebar leaves its pin. **Both manual geometry gestures pass it**: the
   * title-bar drag and the edge resize alike, because either one is the user
   * placing the pane by hand and a hand-placed pane is not in an arrangement.
   *
   * It stays an explicit option rather than a "geometry changed" heuristic
   * because plenty of commits change geometry without being that gesture — the
   * space allocator's rail solve, the width-preset applier, the imposition
   * freeze — and each of those must leave the pane exactly where the structure
   * put it. The sidebar's deck-facing edge is the one resize that does NOT
   * evict, and it does not because it has its own handler
   * (`handleSidebarResizeStart`) that never passes this.
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
        if (evictSlot) delete moved.slot;
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
   * Read a pane frame's live on-screen rect in canvas coordinates, or `null`
   * when the frame is not in the DOM. An imposed pane's `position`/`size` hold
   * last-known values while its real rect is derived by CSS, so any code that
   * needs the truth has to measure the frame. Layout space, not visual: the
   * measurements are divided by `body { zoom }` the same way `snapshotCardRects`
   * does, so the result is directly comparable with stored geometry.
   */
  private _readPaneFrameRect(
    paneId: string,
  ): { x: number; y: number; width: number; height: number } | null {
    if (typeof document === "undefined") return null;
    const escaped = paneId.replace(/["\\]/g, "\\$&");
    const frame = document.querySelector<HTMLElement>(
      `.tug-pane[data-pane-id="${escaped}"]`,
    );
    if (!frame) return null;
    const canvas = frame.parentElement?.getBoundingClientRect() ?? null;
    const zoom = getTugZoom() || 1;
    const rect = frame.getBoundingClientRect();
    return {
      x: (rect.left - (canvas ? canvas.left : 0)) / zoom,
      y: (rect.top - (canvas ? canvas.top : 0)) / zoom,
      width: rect.width / zoom,
      height: rect.height / zoom,
    };
  }

  /**
   * Set the deck's active imposition, or clear it.
   *
   * A kind change keeps every assignment: a slot the new kind does not have is
   * clamped to its last slot rather than dropped, so nothing silently falls out
   * of the arrangement when the user goes from four-up to two-up.
   *
   * Clearing freezes each imposed pane where the user last saw it — the live
   * frame rect is written into `position`/`size` before `slot` goes away, so
   * turning the structure off does not scatter panes back to stale
   * pre-imposition coordinates.
   *
   * Either way the rails return to their pins: choosing an arrangement is
   * choosing one they stand at the ends of. A rail dragged loose and left there
   * is put back by any choice in the Layout card, which is why an unchanged
   * kind is not simply a no-op.
   */
  setImposition(kind: ImpositionKind | null): void {
    const current = this.deckState.imposition.kind;
    if (current === (kind ?? undefined)) {
      this.pinSidebars();
      this.retuneSidebarAllocation();
      return;
    }
    const railCardIds = findSidebarPanes(this.deckState).map(
      ({ pane }) => pane.activeCardId,
    );

    if (kind === null) {
      const frozen = this.deckState.panes.map((pane) => {
        if (pane.slot === undefined) return pane;
        const next: TugPaneState = { ...pane };
        delete next.slot;
        const rect = this._readPaneFrameRect(pane.id);
        if (rect !== null) {
          next.position = { x: rect.x, y: rect.y };
          next.size = { width: rect.width, height: rect.height };
        }
        return next;
      });
      const changes = this._geometryChanges(this.deckState.panes, frozen);
      for (const ch of changes) {
        if (ch.positionChanged) this.cardLifecycle.notifyCardWillMove(ch.id);
        if (ch.sizeChanged) this.cardLifecycle.notifyCardWillResize(ch.id);
      }
      const imposition: DeckImposition = {
        ...this._withSidebarsPinned(this.deckState.imposition),
      };
      delete imposition.kind;
      for (const cardId of railCardIds) this.cardLifecycle.notifyCardWillMove(cardId);
      this.deckState = { ...this.deckState, panes: frozen, imposition };
      this.notify("setImposition");
      for (const ch of changes) {
        if (ch.positionChanged) this.cardLifecycle.notifyCardDidMove(ch.id);
        if (ch.sizeChanged) this.cardLifecycle.notifyCardDidResize(ch.id);
      }
      for (const cardId of railCardIds) this.cardLifecycle.notifyCardDidMove(cardId);
      this.scheduleSave();
      return;
    }

    const panes = this.deckState.panes.map((pane) => {
      if (pane.slot === undefined) return pane;
      const clamped = clampSlot(kind, pane.slot);
      return clamped === pane.slot ? pane : { ...pane, slot: clamped };
    });
    this._commitImposition(
      {
        ...this._withSidebarsPinned(this.deckState.imposition),
        kind,
      },
      panes,
    );
  }

  /**
   * Choose how the deck resolves its slots: `"fit"`, where a slot is an anchor
   * at a fraction of the band, or `"flow"`, where the occupied slots stand in a
   * strip and never overlap.
   *
   * Every pane keeps its slot — the mode changes what a slot MEANS, not which
   * one a card holds — so this commits the record and nothing else, and the
   * frames follow because their `left` is derived from it.
   *
   * A Layouts click is one of THE MOMENTS the deck may re-solve its rails, so
   * this goes through {@link _commitImposition} with the retune left on. It has
   * real work to do here in one direction: leaving flow, the rails have been
   * standing at their preferred widths (the allocator's flow answer) and the
   * seams the fit picture wants are almost certainly somewhere else.
   */
  setImpositionLayout(layout: ImpositionLayout): void {
    const imposition = this.deckState.imposition;
    if (impositionLayout(imposition) === layout) return;
    this._commitImposition({ ...imposition, layout }, this.deckState.panes);
  }

  /**
   * Assign a card to a numbered slot in the active imposition.
   *
   * A card sharing a pane with others is pulled out of that tab strip first —
   * the imposer exists to replace tab strips, so it slots cards, never whole
   * tab groups. A card already alone in its pane slots that pane in place.
   *
   * The assignment always raises, and raises first: slots are stacks, so
   * clicking a number that another pane already holds puts this one on top of
   * it rather than doing nothing — and the raise lands in its own commit ahead
   * of the geometry, so the frame crosses to its slot over the arrangement
   * rather than under it.
   *
   * Because the chain packs tight, a card joining it moves every pane after it
   * as well — the lifecycle ledger below covers the whole chain, not just the
   * card that was clicked. A card JOINING the chain is also one of the moments
   * the space allocator re-solves the rails for (see `retuneSidebarAllocation`):
   * the deck makes room for what it was just asked to arrange. A card already
   * in the chain moving to another slot is not — see {@link assignCardsToSlots},
   * which draws that line.
   *
   * One card is the degenerate batch — {@link assignCardsToSlots} is the
   * implementation, so the single-card and multi-card gestures cannot drift.
   */
  assignCardToSlot(cardId: string, slot: number): SlotAssignment {
    return this.assignCardsToSlots([{ cardId, slot }]);
  }

  /**
   * Assign several cards to slots as one arrangement.
   *
   * The batch is the multi-card gesture's whole point: the FLIP settle in
   * `deck-canvas.tsx` measures where the frames were on the store event and
   * where they landed after React's commit, so a gesture that notifies once
   * per card offers that measurement a half-moved deck each time and re-arms
   * the settle window on every one of them. All the slot writes land in ONE
   * geometry commit, the same reasoning that made `setContentWidth` one
   * commit rather than one per pane.
   *
   * The detaches and the raises still run per card, ahead of the geometry,
   * because that is what they are: pulling a card out of a tab strip changes
   * what the strip IS, and a raise moves nothing (the settle's arrangement
   * signature is z-blind), so neither arms a window of its own. The cards come
   * forward in the order given, which leaves the last one first responder.
   *
   * GROUP REFUSAL. The batch is validated whole before anything moves: one
   * ineligible card refuses all of them. A gesture that half-applies is worse
   * than one that refuses, because the user cannot see which half took.
   *
   * A slot outside the arrangement is one of those ineligibilities rather than
   * something to clamp. Clamping is right when the arrangement itself shrinks
   * (`clampSlot` on a kind change pulls orphaned panes back in); it is wrong
   * for a gesture, because a group clamped against the edge arrives with its
   * members stacked on one slot — the arrangement the user was moving,
   * destroyed by the move. The refusal names the card that blocked it so the
   * caller can point at it.
   */
  assignCardsToSlots(
    entries: readonly { readonly cardId: string; readonly slot: number }[],
  ): SlotAssignment {
    if (entries.length === 0) return { ok: false };
    const kind = this.deckState.imposition.kind;
    if (kind === undefined) {
      console.warn(
        "assignCardsToSlots: no active imposition; cannot slot cards",
      );
      return { ok: false };
    }

    const lastSlot = slotCount(kind) - 1;
    for (const { cardId, slot } of entries) {
      const host = this.deckState.panes.find((p) => p.cardIds.includes(cardId));
      if (!host) {
        console.warn(`assignCardsToSlots: no pane holds card "${cardId}"`);
        return { ok: false };
      }
      const hostsSidebar = this.deckState.cards.some(
        (c) => host.cardIds.includes(c.id) && isSidebarCard(c.componentId),
      );
      if (hostsSidebar) {
        // A sidebar card pins to a deck edge and insets the band — it is the
        // imposition's fixed end, not the chain's to place.
        console.warn(
          `assignCardsToSlots: card "${cardId}" is hosted in the sidebar pane "${host.id}"`,
        );
        return { ok: false };
      }
      if (!Number.isFinite(slot) || slot < 0 || slot > lastSlot) {
        return { ok: false, blockedCardId: cardId };
      }
    }

    // Which panes already stood in the chain, read BEFORE anything moves.
    // This is what separates a card joining the chain from a card moving
    // inside it, and the two get different answers below.
    const chainBefore = new Set(
      this.deckState.panes.filter((p) => p.slot !== undefined).map((p) => p.id),
    );

    const targets = new Map<string, number>();
    for (const { cardId, slot } of entries) {
      // Re-read the host each pass: an earlier detach rebuilds the panes array.
      const host = this.deckState.panes.find((p) => p.cardIds.includes(cardId));
      if (!host) continue;

      // `_detachCard` returns null when the card is alone in its pane — that is
      // exactly the "slot the existing host" branch, no detach needed.
      const detachedPaneId =
        host.cardIds.length > 1
          ? this._detachCard(host.id, cardId, host.position)
          : null;
      const targetPaneId = detachedPaneId ?? host.id;

      // Raise BEFORE the geometry, in its own commit.
      //
      // Assigning always raises: the slotted card becomes the active one, as a
      // first-class activation. Doing it after the geometry commit would leave
      // the frame crossing to its slot underneath the panes it is on its way to
      // sitting in front of — the raise is a precondition of the motion, not its
      // epilogue.
      //
      // A raw `activateCard` here would flip the first responder but skip the
      // focus transfer — the outgoing card (the Lens, whose list dispatched the
      // assign) would never save its bag, and the slotted card would never
      // receive its focus claim (no caret until the user clicks into it).
      // Detaching has already raised and activated the new pane, in which case
      // this is the same-bit refresh.
      transferFocusForActivation({
        outgoingCardId: this.getFirstResponderCardId(),
        incomingCardId: cardId,
        store: this,
        commitMutation: () => this.activateCard(cardId),
      });

      targets.set(targetPaneId, clampSlot(kind, slot));
    }
    if (targets.size === 0) return { ok: false };

    // Re-placing a pane ends its bullseye. This path writes `slot` on its own
    // rather than through `movePane`, so it honors the rule explicitly.
    for (const paneId of targets.keys()) this._clearBullseyeFor(paneId);

    const panes = this.deckState.panes.map((p) => {
      const slot = targets.get(p.id);
      return slot === undefined ? p : ({ ...p, slot } as TugPaneState);
    });
    // Everything in the chain moves, including the panes that kept their
    // slots: these cards' widths are now part of what precedes them.
    //
    // Whether the RAILS move too turns on membership, not on the verb. A pane
    // ENTERING the chain — a loose card gaining a slot, or a card pulled out of
    // a tab group into a pane of its own — changes what the chain is, and the
    // deck makes room for what it was just asked to arrange; that is the moment
    // `retuneSidebarAllocation` was written for. A pane that already had a slot
    // taking a different one is not that gesture: membership is unchanged,
    // nothing new needs room, and re-solving would hand the width freed by a
    // tighter pack to the rails — growing a sidebar by most of a card on a
    // chord that named one card.
    //
    // Which is the same fault, from the other side, that `setCardWidths` takes
    // `retuneRails: false` for. Both verbs are card-addressed and neither may
    // spend a rail; what licenses a re-solve is the Layouts click, the settled
    // resize, and a change to who is in the chain.
    const joinsChain = [...targets.keys()].some((id) => !chainBefore.has(id));
    this._commitImposition(this.deckState.imposition, panes, {
      retuneRails: joinsChain,
      // The batch leaves its last card first responder, and that is the card
      // the user is looking for; a slot whose column overflows must scroll it
      // into the run or the assignment lands somewhere nobody can see.
      revealPaneId: [...targets.keys()][targets.size - 1],
    });
    return { ok: true };
  }

  /**
   * The imposition the arriving pane's column should hold, with the pane at the
   * index the caller asked for.
   *
   * Folded into the assignment's own commit rather than written after it,
   * because a card crossing into a split column changes two things about the
   * arrangement — which slot it stands in and where in that slot's order it
   * stands — and the settle can only animate them as one motion if they arrive
   * as one commit. Two commits would measure the deck once with the card
   * arrived but unplaced, which is a frame nobody asked to see.
   *
   * An indexed arrival into a slot holding exactly one other pane is the
   * dividing gesture ([P07]): the drop CREATES the split — mode and order in
   * the same imposition, so the commit that places the pane is the commit
   * that divides the slot. The zones advertised that index (Spec S02), so
   * honoring it by z-stacking would break the indicator's promise.
   *
   * Returns the imposition unchanged when no index was asked for, when the
   * destination is a stacked column of two or more other panes — a stack is
   * an arrangement the user chose, its order is z-order, and nothing here may
   * write it — or when the slot holds nothing else (nothing to divide).
   */
  private _impositionWithArrival(
    panes: readonly TugPaneState[],
    paneId: string,
    slot: number,
    index: number | undefined,
  ): DeckImposition {
    const imposition = this.deckState.imposition;
    if (index === undefined) return imposition;
    const column = deckColumnsOf({ ...this.deckState, panes }).find(
      (c) => c.slot === slot,
    );
    if (column === undefined) return imposition;
    // `panes` already carries the arrival, so a slot that held one pane reads
    // back as a column of two: the arrival plus the sitter it divides with.
    if (column.mode !== "split" && column.members.length !== 2) {
      return imposition;
    }
    const others = column.members.filter((id) => id !== paneId);
    const order = [...others];
    order.splice(Math.max(0, Math.min(index, others.length)), 0, paneId);
    const divided =
      column.mode === "split"
        ? imposition
        : withColumnMode(imposition, slot, "split");
    return withColumnOrder(divided, slot, order);
  }

  /**
   * Move a whole pane to `slot`, optionally landing it at `index` in that
   * slot's split column — the drop-zone drag's commit for a card crossing
   * places ([P10]).
   *
   * Pane-addressed, where {@link assignCardsToSlots} is card-addressed, because
   * the two gestures have different subjects. The Layouts click names a card
   * and means that card, so a card pulled from a tab stack detaches into a pane
   * of its own. A title-bar drag names the pane — the box the hand is holding,
   * tabs and all — and detaching its front tab mid-flight would leave the rest
   * of the stack behind at the place the user just dragged away from.
   *
   * One call and one commit, which is the point of taking the index here rather
   * than in a `setColumnOrder` afterwards: the slot write and the order write
   * are the same arrangement change, and the settle animates an arrangement
   * change once. Two commits would show the deck a frame with the pane arrived
   * but unplaced.
   *
   * Refuses on the same grounds a slot assignment refuses — no imposition, no
   * such pane, a slot outside the arrangement, a pane pinned to a rail — and
   * the drop must read the answer rather than assume it ([P09]).
   */
  movePaneToSlot(paneId: string, slot: number, index?: number): SlotAssignment {
    const kind = this.deckState.imposition.kind;
    if (kind === undefined) {
      console.warn("movePaneToSlot: no active imposition; cannot place a pane");
      return { ok: false };
    }
    const pane = this.deckState.panes.find((p) => p.id === paneId);
    if (pane === undefined) {
      console.warn(`movePaneToSlot: no pane "${paneId}"`);
      return { ok: false };
    }
    const hostsSidebar = this.deckState.cards.some(
      (c) => pane.cardIds.includes(c.id) && isSidebarCard(c.componentId),
    );
    if (hostsSidebar) {
      console.warn(`movePaneToSlot: pane "${paneId}" is a sidebar pane`);
      return { ok: false };
    }
    if (!Number.isFinite(slot) || slot < 0 || slot > slotCount(kind) - 1) {
      return { ok: false, blockedCardId: pane.activeCardId };
    }

    const joinsChain = pane.slot === undefined;
    // The raise goes ahead of the geometry for the reason it does in
    // `assignCardsToSlots`: a pane crossing to its new place must travel over
    // the panes it is about to sit in front of, not under them.
    transferFocusForActivation({
      outgoingCardId: this.getFirstResponderCardId(),
      incomingCardId: pane.activeCardId,
      store: this,
      commitMutation: () => this.activateCard(pane.activeCardId),
    });
    this._clearBullseyeFor(paneId);

    const placed = clampSlot(kind, slot);
    const panes = this.deckState.panes.map((p) =>
      p.id === paneId ? ({ ...p, slot: placed } as TugPaneState) : p,
    );
    this._commitImposition(
      this._impositionWithArrival(panes, paneId, placed, index),
      panes,
      { retuneRails: joinsChain, revealPaneId: paneId },
    );
    return { ok: true };
  }

  /** Per-pane position/size deltas between two pane arrays of the same shape,
   *  keyed by active card, for the will/did move/resize lifecycle events. */
  private _geometryChanges(
    before: readonly TugPaneState[],
    after: readonly TugPaneState[],
  ): { id: string; positionChanged: boolean; sizeChanged: boolean }[] {
    const changes: {
      id: string;
      positionChanged: boolean;
      sizeChanged: boolean;
    }[] = [];
    for (let i = 0; i < before.length; i += 1) {
      const b = before[i];
      const a = after[i];
      const positionChanged =
        b.position.x !== a.position.x || b.position.y !== a.position.y;
      const sizeChanged =
        b.size.width !== a.size.width || b.size.height !== a.size.height;
      if (positionChanged || sizeChanged) {
        changes.push({ id: a.activeCardId, positionChanged, sizeChanged });
      }
    }
    return changes;
  }

  // ---- Per-card state cache API ([D01], [D06]) ----

  getCardState(cardId: string): CardStateBag | undefined {
    return this.cardStateCache.get(cardId);
  }

  setCardState(cardId: string, bag: CardStateBag): void {
    this.cardStateCache.set(cardId, bag);
    this.dirtyCardIds.add(cardId);

    // While a batch load holds the save gate, mark dirty but schedule no
    // flush — never a `fetch` mid-load. The accumulated state is persisted a
    // beat after the load when the gate releases (see `suspendCardStateSaves`),
    // and any sync unload flush bypasses the gate regardless.
    if (this.cardSaveSuspendDepth > 0) return;

    if (this.cardStateSaveTimer !== null) {
      window.clearTimeout(this.cardStateSaveTimer);
    }
    this.cardStateSaveTimer = window.setTimeout(() => {
      this.flushDirtyCardStates();
      this.cardStateSaveTimer = null;
    }, CARD_STATE_FLUSH_DEBOUNCE_MS);
  }

  /**
   * Capture `cardId`'s current bag and persist it durably immediately,
   * skipping the {@link CARD_STATE_FLUSH_DEBOUNCE_MS} window. The prompt
   * entry calls this on submit: `editor.clear()` empties the draft, but the
   * debounced save that would persist the cleared state is still pending,
   * and WKWebView fires no `beforeunload`/`visibilitychange` on quit — so a
   * relaunch in that window would otherwise restore the just-submitted
   * message from the stale pre-submit bag. Forcing the write here closes
   * the window independent of the quit path.
   *
   * `keepalive` lets the PUT outlive an immediately-following teardown. A
   * batch load that holds the save gate leaves the bag captured in the
   * in-memory cache and dirty; the post-load debounce persists it. [L23].
   */
  flushCardStateNow(cardId: string): void {
    this.setCardState(cardId, this.captureCardState(cardId));
    if (this.cardStateSaveTimer !== null) {
      window.clearTimeout(this.cardStateSaveTimer);
      this.cardStateSaveTimer = null;
    }
    void this.flushDirtyCardStates({ keepalive: true });
  }

  /**
   * Write all dirty per-card state bags to tugbank and clear the dirty set.
   *
   * Persists under `dev.tugtool.deck.cardstate/{cardId}`. `putCardState` uses
   * the card id, which is numerically identical to the former tab id from the one-table model.
   */
  /**
   * Suspend debounced card-state saves while a batch load runs, returning a
   * disposer that resumes them. Counted, so overlapping loads compose. A card
   * holds this across its load + settle so persistence never fetches mid-load.
   *
   * On the final release the settled state is persisted, but one beat PAST the
   * load — the disposer schedules the debounced flush rather than fetching
   * synchronously, so the write lands well clear of the load's hot path. The
   * beat is a macrotask timer (the existing save debounce), never a
   * `requestAnimationFrame` ([L05]). A new load starting within that window
   * cancels the pending flush on engage and re-schedules on its own release.
   * Sync unload flushes are never suspended.
   */
  suspendCardStateSaves = (): (() => void) => {
    this.cardSaveSuspendDepth += 1;
    // Cancel a flush scheduled just before the gate engaged (a pre-load save,
    // or a prior release's deferred flush) so nothing fires ungated mid-load.
    if (this.cardStateSaveTimer !== null) {
      window.clearTimeout(this.cardStateSaveTimer);
      this.cardStateSaveTimer = null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.cardSaveSuspendDepth = Math.max(0, this.cardSaveSuspendDepth - 1);
      // Final release with dirty state: persist it a beat past the load via
      // the debounced flush ([L05] — a macrotask timer, never rAF), off the
      // hot path. A real `setCardState` in the meantime just resets the same
      // debounce; the next load's engage cancels it.
      if (this.cardSaveSuspendDepth === 0 && this.dirtyCardIds.size > 0) {
        if (this.cardStateSaveTimer !== null) {
          window.clearTimeout(this.cardStateSaveTimer);
        }
        this.cardStateSaveTimer = window.setTimeout(() => {
          void this.flushDirtyCardStates();
          this.cardStateSaveTimer = null;
        }, CARD_STATE_FLUSH_DEBOUNCE_MS);
      }
    };
  };

  /**
   * Write all dirty per-card state bags to tugbank, clear the dirty set,
   * and resolve one {@link CardFlushResult} per attempted write.
   *
   * A card whose write failed is re-marked dirty before the promise
   * resolves, so the next flush — the debounced one, or the termination
   * pipeline's retry — picks it up again. Silently dropping the bag was
   * the loss path this replaces ([L23]).
   */
  private flushDirtyCardStates(options?: { keepalive?: boolean; sync?: boolean; force?: boolean }): Promise<CardFlushResult[]> {
    // Deferred while a batch load holds the save gate — the dirty set is
    // retained and saved on a later ungated trigger. A `sync` flush
    // (will-phase / unload) must always run, so it bypasses; `force` is
    // the async-fetch equivalent for teardown-class callers that await
    // the writes (prepareForReload) — "no fetch mid-load" is moot when
    // the page is about to be torn down.
    if (this.cardSaveSuspendDepth > 0 && options?.sync !== true && options?.force !== true) {
      return Promise.resolve([]);
    }
    const promises: Promise<CardFlushResult>[] = [];
    for (const cardId of this.dirtyCardIds) {
      const bag = this.cardStateCache.get(cardId);
      if (bag !== undefined) {
        promises.push(
          this.putCardStateGuarded(cardId, bag, options).then((ok) => {
            if (!ok) this.dirtyCardIds.add(cardId);
            return { cardId, ok };
          }),
        );
      }
    }
    this.dirtyCardIds.clear();
    return Promise.all(promises);
  }

  // ---- Save callback registration ([D01]) ----

  registerSaveCallback(id: string, callback: (source?: SaveCallbackSource) => void): void {
    this.saveCallbacks.set(id, callback);
  }

  unregisterSaveCallback(id: string): void {
    this.saveCallbacks.delete(id);
  }

  /**
   * Invoke the registered save callback for `id`, if any, recording a
   * `save-callback` deck-trace event tagged with the caller-supplied
   * `source`. `source` is optional for backward compatibility with
   * mock stores in the test suite (they implement the interface with
   * the one-arg shape and still type-check); live callers always pass
   * an explicit tag so the trace preserves the triggering path.
   *
   * The tag is also handed to the callback itself, which forwards it
   * down the capture chain: a card can then capture differently for a
   * save it will never get a render after (`"termination"`) than for a
   * steady-state one.
   *
   * See `deck-trace` for the `save-callback` event shape
   * and the recording-sites list for per-source wiring.
   */
  invokeSaveCallback(id: string, source?: SaveCallbackSource): void {
    const tag: SaveCallbackSource = source ?? "manual";
    deckTrace.record({
      kind: "save-callback",
      cardId: id,
      source: tag,
    });
    this.saveCallbacks.get(id)?.(tag);
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

  /**
   * Per-card engine hooks (`paintMirrorAsActive` / `paintMirrorAsInactive`).
   * Last-registration-wins per cardId. Phase E.11 Step 2 adds the
   * channel (additive, no consumer yet); Step 3 wires
   * `applyBagFocus` to invoke through these hooks for the `engine`
   * resolution kind.
   */
  private engineHooks: Map<string, EngineHooks> = new Map();

  /**
   * Per-card engine-hook-change listeners. `CardHost` subscribes
   * here in a `useLayoutEffect` so its cold-boot RESTORE effect
   * re-fires when an engine registers late (dev's editor mounts
   * after `feedsReady`). Last-registration-wins per (cardId,
   * listener) — the listener identity is what we key on internally,
   * via a Set per cardId.
   */
  private engineHooksListeners: Map<string, Set<() => void>> = new Map();

  registerEngineHooks(cardId: string, hooks: EngineHooks): () => void {
    this.engineHooks.set(cardId, hooks);
    // Notify CardHost (and any other subscriber) that the engine
    // hooks for this card just changed — drives Phase E.11 Step 4's
    // `deferred-engine` retry. Listeners fire even on
    // last-write-wins re-registration so a TugTextEditor remount
    // (HMR, cross-pane move) lights up the dispatcher's re-fire
    // path.
    const listeners = this.engineHooksListeners.get(cardId);
    if (listeners !== undefined) {
      for (const listener of listeners) {
        try {
          listener();
        } catch (err) {
          console.error("[deck-manager] engine-hooks listener threw:", err);
        }
      }
    }
    return () => {
      // Only clear when we still own the slot.
      if (this.engineHooks.get(cardId) === hooks) {
        this.engineHooks.delete(cardId);
        // Notify on unregister too so subscribers can clear
        // engine-derived state cleanly. A successor registration
        // (e.g. cross-pane move) fires a second notify when its
        // own `registerEngineHooks` runs.
        const cleanupListeners = this.engineHooksListeners.get(cardId);
        if (cleanupListeners !== undefined) {
          for (const listener of cleanupListeners) {
            try {
              listener();
            } catch (err) {
              console.error(
                "[deck-manager] engine-hooks listener threw on unregister:",
                err,
              );
            }
          }
        }
      }
    };
  }

  invokeEnginePaintMirrorAsActive(cardId: string): void {
    const hooks = this.engineHooks.get(cardId);
    if (hooks === undefined) return;
    try {
      hooks.paintMirrorAsActive();
    } catch (err) {
      console.error(
        "[deck-manager] engine paintMirrorAsActive threw:",
        err,
      );
    }
  }

  invokeEnginePaintMirrorAsInactive(cardId: string): void {
    const hooks = this.engineHooks.get(cardId);
    if (hooks === undefined) return;
    try {
      hooks.paintMirrorAsInactive();
    } catch (err) {
      console.error(
        "[deck-manager] engine paintMirrorAsInactive threw:",
        err,
      );
    }
  }

  hasEngineHooks(cardId: string): boolean {
    return this.engineHooks.has(cardId);
  }

  /**
   * Subscribe to engine-hook registration events for `cardId`. The
   * listener fires after `registerEngineHooks` (or its cleanup)
   * runs, including last-write-wins re-registrations from the same
   * `cardId`. Returns an unsubscribe function.
   *
   * Used by `CardHost` to re-fire its cold-boot RESTORE effect when
   * a late-mounting engine registers; bridges the dispatcher's
   * `deferred-engine` retry path to the engine's mount lifecycle.
   * The channel is Phase E.11 Step 2 infrastructure; Step 4 wires
   * the retry in `CardHost`.
   */
  subscribeEngineHooksChange(
    cardId: string,
    listener: () => void,
  ): () => void {
    let listeners = this.engineHooksListeners.get(cardId);
    if (listeners === undefined) {
      listeners = new Set();
      this.engineHooksListeners.set(cardId, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.engineHooksListeners.get(cardId);
      if (set !== undefined) {
        set.delete(listener);
        if (set.size === 0) this.engineHooksListeners.delete(cardId);
      }
    };
  }

  /**
   * Return the per-card Component State Preservation Protocol registry
   * ([D13], [A9]) for `cardId`, creating it lazily on first call. Used
   * by `useComponentStatePreservation` to register / unregister
   * capture/restore closures; used by the framework orchestration layer
   * (`captureCardState`) at save time.
   *
   * The registry is discarded in
   * `discardComponentStatePreservationRegistry(cardId)` once the card
   * is destroyed, so repeated create / destroy cycles of the same
   * cardId yield fresh registries.
   */
  getComponentStatePreservationRegistry(cardId: string): ComponentStatePreservationRegistry {
    let registry = this.componentStatePreservationRegistries.get(cardId);
    if (!registry) {
      registry = new ComponentStatePreservationRegistry();
      this.componentStatePreservationRegistries.set(cardId, registry);
    }
    return registry;
  }

  /**
   * Look up a card's component state preservation registry without
   * creating one. Returns `undefined` when the card has never
   * registered an opt-in component. Used by the capture/restore
   * orchestration so a non-participating card incurs no allocation.
   */
  peekComponentStatePreservationRegistry(
    cardId: string,
  ): ComponentStatePreservationRegistry | undefined {
    return this.componentStatePreservationRegistries.get(cardId);
  }

  /**
   * Discard the per-card component state preservation registry for
   * `cardId`. Called from `_removeCard` and `_closePane` alongside
   * `flushSaveCallbackBeforeDestruction` so a card's registered
   * closures don't outlive the card itself.
   */
  private discardComponentStatePreservationRegistry(cardId: string): void {
    const registry = this.componentStatePreservationRegistries.get(cardId);
    if (!registry) return;
    registry.clear();
    this.componentStatePreservationRegistries.delete(cardId);
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

  /**
   * The teardown-save core every teardown-class path runs through.
   *
   * Always, in this order: retire the pending debounced layout save
   * (writing it when one was in flight, or unconditionally when the
   * caller asks), invoke every registered save callback tagged with
   * `source`, then flush the dirty card-state bags. The wrappers add
   * only their own guard semantics — the *guarantee* lives here, once,
   * so no entry point can hold a partial version of it. `saveAndFlushSync`
   * used to skip the layout half entirely, which dropped any layout
   * change still inside its debounce window on ⌘Q.
   *
   * `layoutSave: "always"` is for callers that own a whole termination
   * (reload, quit): the extra write costs nothing on a once-per-exit path
   * and makes the reported `layoutSaved` mean "the current layout is on
   * disk". The default `"if-pending"` keeps the frequent teardown signals
   * (HMR, visibilitychange) from writing a layout that never changed.
   *
   * Everything imperative happens synchronously before the first await, so
   * a `sync` caller on the unload path still gets its XHR writes issued
   * inline. [L23]; [L10] — per-card capture is dispatched through
   * `invokeSaveCallback`, never by reaching into card internals.
   */
  private teardownSave(
    source: SaveCallbackSource,
    options?: { layoutSave?: "if-pending" | "always"; sync?: boolean; force?: boolean },
  ): Promise<TeardownSaveResult> {
    const layoutPending = this.saveTimer !== null;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const layoutPromise =
      layoutPending || options?.layoutSave === "always"
        ? this.saveLayout()
        : Promise.resolve(true);

    // Snapshot the keys first so a callback that unregisters another
    // card mid-iteration does not confuse the Map iterator.
    for (const cardId of Array.from(this.saveCallbacks.keys())) {
      this.invokeSaveCallback(cardId, source);
    }

    // Drain any prompt append still in the outbox. A `sync` teardown is the
    // page going away, where a queued fetch would never settle — and a prompt
    // the user submitted has to reach the ledger before the process does. Runs
    // after the card callbacks so a submit folded in by `"termination"` is
    // already queued. [L23]
    if (options?.sync === true) {
      flushPromptHistorySync();
    }

    const cardsPromise = this.flushDirtyCardStates({
      sync: options?.sync,
      force: options?.force,
    });

    return Promise.all([layoutPromise, cardsPromise]).then(([layoutSaved, cards]) => ({
      layoutSaved,
      cards,
    }));
  }

  /**
   * The deck's half of an application quit, run to completion before the
   * host signals any child process.
   *
   * Four ordered phases:
   *
   *   1. **Interrupt** every session that reports `canInterrupt`, and wait
   *      for each to settle (bounded). Nothing else may run first: a turn
   *      that is still streaming when the process group dies is a rug pull,
   *      and a CASE A interrupt parks the user's un-answered submission in
   *      `pendingDraftRestore` — which only exists for the capture phase to
   *      find if the interrupt happened first.
   *   2. **Capture** through the teardown-save core with source
   *      `"termination"`, which is the tag that tells a card to fold in
   *      text it holds outside its visible surface (queued sends, the
   *      pulled-back submission from phase 1).
   *   3. **Retry** any card write tugbank rejected, within a bounded
   *      budget — quit routinely races the supervisor restarting tugcast.
   *   4. **Report** what actually happened. The host logs the verdict; it
   *      does not act on it.
   *
   * Never rejects and never blocks indefinitely: every wait is bounded and
   * early-exits, so a quit with nothing live and nothing dirty pays for
   * none of them. Re-entrant calls join the first run's promise.
   *
   * [L23] — this is the transition the whole plan exists to make safe.
   */
  prepareForTermination(): Promise<TerminationVerdict> {
    if (this.terminationRun !== null) return this.terminationRun;
    this.terminationRun = this.runTerminationPipeline();
    return this.terminationRun;
  }

  private terminationRun: Promise<TerminationVerdict> | null = null;

  private async runTerminationPipeline(): Promise<TerminationVerdict> {
    const startedAt = Date.now();

    const { interrupted, unacknowledged } = await this.interruptLiveSessions();

    const attempted = new Set<string>();
    const first = await this.teardownSave("termination", {
      layoutSave: "always",
      force: true,
    });
    for (const result of first.cards) attempted.add(result.cardId);

    let failedCards = first.cards.filter((r) => !r.ok).map((r) => r.cardId);
    let layoutSaved = first.layoutSaved;
    if (failedCards.length > 0 || !layoutSaved) {
      const retried = await this.retryFailedWrites(attempted, layoutSaved);
      failedCards = retried.failedCards;
      layoutSaved = retried.layoutSaved;
    }

    // Lock the framework against further saves the way `saveAndFlushSync`
    // does — a late `beforeunload` must not re-open the bags this run
    // just closed.
    this.stateFlushed = true;

    return {
      ok: unacknowledged.length === 0 && failedCards.length === 0 && layoutSaved,
      interrupted,
      unacknowledged,
      flushedCards: attempted.size - failedCards.length,
      failedCards,
      layoutSaved,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /**
   * Interrupt every live session and wait for each to settle, up to
   * {@link TERMINATION_INTERRUPT_AWAIT_MS}.
   *
   * "Live" is the session's own published `canInterrupt` — [L28]: the
   * lifecycle owner decides what can be interrupted, and a caller that
   * re-derived the phase test would drift from it. In particular a
   * `replaying` session is deliberately excluded: the bracket window owns
   * the card, nothing durable is at risk (replay re-runs on the next boot),
   * and `handleInterrupt` has no `replaying` guard — an interrupt sent
   * there would reset the store to idle mid-replay.
   *
   * Settled is `phase ∈ {idle, errored}`: a CASE A interrupt reaches it
   * synchronously; a CASE B turn reaches it when the wire's
   * `turn_complete(error)` commits the interrupted entry. Every
   * subscription is released on acknowledgment *and* on expiry ([L27]).
   */
  private async interruptLiveSessions(): Promise<{
    interrupted: string[];
    unacknowledged: string[];
  }> {
    const live = cardServicesStore
      .allServices()
      .map((services) => services.codeSessionStore)
      .filter((store) => store.getSnapshot().canInterrupt);

    if (live.length === 0) {
      return Promise.resolve({ interrupted: [], unacknowledged: [] });
    }

    return new Promise((resolve) => {
      const interrupted: string[] = [];
      const pending = new Map<CodeSessionStore, () => void>();
      let timer: number | null = null;

      const settled = (store: CodeSessionStore): boolean => {
        const phase = store.getSnapshot().phase;
        return phase === "idle" || phase === "errored";
      };

      const finish = (): void => {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        const unacknowledged: string[] = [];
        for (const [store, unsubscribe] of pending) {
          unsubscribe();
          unacknowledged.push(store.getSnapshot().tugSessionId);
        }
        pending.clear();
        resolve({ interrupted, unacknowledged });
      };

      const acknowledge = (store: CodeSessionStore): void => {
        const unsubscribe = pending.get(store);
        if (unsubscribe === undefined) return;
        unsubscribe();
        pending.delete(store);
        interrupted.push(store.getSnapshot().tugSessionId);
        if (pending.size === 0) finish();
      };

      // Subscribe to every store before interrupting any of them: a CASE A
      // interrupt settles synchronously inside `interrupt()`, so a
      // subscribe-then-interrupt-per-store loop would let the first store's
      // acknowledgment see an incomplete pending set and finish early.
      for (const store of live) {
        pending.set(
          store,
          store.subscribe(() => {
            if (settled(store)) acknowledge(store);
          }),
        );
      }

      // Preserve each session's queued text before interrupting: a CASE A
      // interrupt clears `queuedSends`, so the capture phase would
      // otherwise find an empty queue for exactly the sessions that had
      // one.
      for (const store of live) {
        store.stashUnsentText();
        store.interrupt();
      }

      // Sweep for anything that settled without notifying us in a way we
      // observed (a synchronous settle during `interrupt()` is handled by
      // the subscription; this covers the rest).
      for (const store of Array.from(pending.keys())) {
        if (settled(store)) acknowledge(store);
      }

      if (pending.size === 0) return;
      timer = window.setTimeout(finish, TERMINATION_INTERRUPT_AWAIT_MS);
    });
  }

  /**
   * Re-attempt whatever tugbank rejected — card bags and the layout alike —
   * until it all lands or the budget runs out.
   *
   * The realistic reason a write fails at quit is that tugcast is
   * mid-restart (the supervisor's first backoff step is a second), so the
   * same outage takes down every write in the run and one retry pass
   * recovers all of them. `flushDirtyCardStates` re-marks a failed card
   * dirty, so each pass naturally targets exactly the outstanding cards;
   * the layout has no dirty bit, so it is simply re-sent until it sticks.
   *
   * Returns what is still failing when the budget expired, for the verdict
   * to report by name.
   */
  private async retryFailedWrites(
    attempted: Set<string>,
    layoutAlreadySaved: boolean,
  ): Promise<{ layoutSaved: boolean; failedCards: string[] }> {
    const deadline = Date.now() + TERMINATION_FLUSH_RETRY_BUDGET_MS;
    let layoutSaved = layoutAlreadySaved;
    let failed: string[] = [];
    while (Date.now() < deadline) {
      await new Promise<void>((r) =>
        window.setTimeout(() => r(), TERMINATION_FLUSH_RETRY_INTERVAL_MS),
      );
      if (!layoutSaved) layoutSaved = await this.saveLayout();
      const results = await this.flushDirtyCardStates({ force: true });
      for (const result of results) attempted.add(result.cardId);
      failed = results.filter((r) => !r.ok).map((r) => r.cardId);
      if (layoutSaved && failed.length === 0) return { layoutSaved, failedCards: [] };
    }
    return { layoutSaved, failedCards: failed };
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

  // ---- Test-mode state seeding ([D02]) ----

  /**
   * Replace the current `DeckState` atomically, merge per-card state
   * bags into the in-memory cache, and optionally activate a focused
   * card. The single source of state for a test-mode session ([D02]):
   * harness authors describe the desired axis state; this method
   * installs it in one commit.
   *
   * Semantics:
   * - `this.deckState` is replaced with `args.state` verbatim (no
   *   merge with the previous state). The caller is responsible for
   *   passing a fully-formed `DeckState`.
   * - `args.cardStates` (if present) is merged into
   *   `this.cardStateCache`; existing entries for other card ids are
   *   preserved so repeated `seedDeckState` calls can layer state.
   * - `args.focusCardId` (if present) drives the cold-boot restore
   *   path — `activateCard(id)` runs after the state commit when the
   *   card exists in the new state.
   *
   * Callable in non-test-mode too so harness-authored scenarios can
   * exercise the same entry point inside unit tests that don't
   * construct a whole bridge. The I/O guards elsewhere ensure a
   * non-test-mode caller still routes writes to tugbank normally —
   * `seedDeckState` itself issues no tugbank I/O.
   *
   * Subscribers are notified exactly once via `this.notify()` at the
   * end of the commit; `useSyncExternalStore` consumers see a single
   * state transition, not a series of partial ones.
   */
  seedDeckState(args: {
    state: DeckState;
    cardStates?: Map<string, CardStateBag>;
    focusCardId?: string;
  }): void {
    // Clear construction lifecycle memory for cards that are leaving
    // the deck so a later `seedDeckState` call that re-introduces an
    // id does not double-fire construction. Fresh-card construction
    // below picks up the id set that resulted from the replace.
    const previousCardIds = new Set(this.deckState.cards.map((c) => c.id));
    const nextCardIds = new Set(args.state.cards.map((c) => c.id));

    // Atomic state replace: one assignment, one notify, one snapshot
    // transition for useSyncExternalStore consumers. hasFocus is
    // session-only — the caller supplies it in `args.state`.
    //
    // The state arrives as JSON across the test bridge, so its type is a
    // claim rather than a guarantee: a seed that predates `imposition`
    // omits it. Fill the default rather than letting `undefined` reach the
    // render, the same posture `deserialize` takes at the wire boundary.
    this.deckState = {
      ...args.state,
      imposition: args.state.imposition ?? {
        kind: DEFAULT_IMPOSITION_KIND,
        sidebars: { [CARDS_CARD_ID]: { side: DEFAULT_SIDEBAR_SIDE } },
      },
    };

    // Re-project the seeded `hasFocus` onto `data-app-active`. The
    // constructor seeds the DOM bit from `document.hasFocus()`, but a
    // seed supplies its own `hasFocus` (tests typically `true`); without
    // this the projection stays stuck at the construction-time reading,
    // leaving `data-app-active` out of sync with `deckState.hasFocus`.
    // `setHasFocus` can't recover it (it early-returns when the value is
    // unchanged), so the focus-language ring on a foregrounded seed would
    // stay quiet. Reflect here so the DOM matches the seeded state.
    this.reflectAppActive(this.deckState.hasFocus);

    if (args.cardStates) {
      for (const [cardId, bag] of args.cardStates) {
        this.cardStateCache.set(cardId, bag);
      }
    }

    // Fire construction for every card that just entered the deck so
    // lifecycle subscribers' `constructedCards` set matches reality
    // (mirrors the constructor's post-load fan-out in the normal boot
    // path).
    for (const card of args.state.cards) {
      if (!previousCardIds.has(card.id)) {
        this.cardLifecycle.notifyCardDidFinishConstruction(card.id);
      }
    }

    // Discard per-card component state preservation registries for
    // cards that left the deck so closures don't outlive the card.
    // Explicit cleanup, symmetric with `_removeCard` / `_closePane`.
    for (const prevId of previousCardIds) {
      if (!nextCardIds.has(prevId)) {
        // discardComponentStatePreservationRegistry is private; inline
        // the equivalent cleanup so we don't widen the surface.
        const registry = this.componentStatePreservationRegistries.get(prevId);
        if (registry) {
          registry.clear();
          this.componentStatePreservationRegistries.delete(prevId);
        }
      }
    }

    this.notify("seedDeckState");

    // Cold-boot restore: after the state commit, activate the
    // requested focus card. `activateCard` is the single entry point
    // for z-order + lifecycle + responder-chain updates ([D03]).
    if (args.focusCardId !== undefined) {
      const exists = this.deckState.cards.some(
        (c) => c.id === args.focusCardId,
      );
      if (exists) {
        this.activateCard(args.focusCardId);
      }
    }
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
      this.cardStateCache.set(cardId, { content: initialContent });
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
   * Transition 8a: when the removed card is the first responder, flip
   * the composite bit to the neighbor BEFORE firing
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

    const wasRemovingFR = this.getFirstResponderCardId() === cardId;
    const spliced = spliceCardFromStack(win, cardId);
    // `cardIds.length > 1` above guarantees a survivor → activeCardId !== null.
    const newActiveCardId = spliced.activeCardId as string;

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
    if (wasRemovingFR) {
      transferFocusForActivation({
        outgoingCardId: cardId,
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
    this.deckState = {
      ...this.deckState,
      cards: this.deckState.cards.filter((c) => c.id !== cardId),
      panes: this.deckState.panes.map((s) => (s.id === paneId ? finalStack : s)),
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

    const sourceWillBeDestroyed = sourceStack.cardIds.length === 1;

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
   * rather than a notify per pane. The settle is FLIP: `deck-canvas.tsx` reads
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
   * `setContentWidth`: choosing the deck's content width is a Layouts click,
   * one of the moments the deck is licensed to re-arrange itself, while sizing
   * the card you are looking at is not. Re-solving here shrank the Lens to its
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

  // ---- Cascade positioning ----

  private nextCascadePosition(stackSize: { width: number; height: number }): { x: number; y: number } {
    const canvasWidth = this.container.clientWidth || 800;
    const canvasHeight = this.container.clientHeight || 600;

    // Classic macOS cascade: there is a prime ("zero") slot near the
    // top-left and a sequence of slots stepping down-and-to-the-right
    // from it. A new card fills the FIRST open slot in that sequence —
    // it does not just keep stepping past freed positions — so closing
    // a card opens its slot for the next one. A slot counts as occupied
    // when an existing pane's top-left sits within CASCADE_SLOP of it,
    // so the match is fuzzy rather than pixel-exact.
    const CASCADE_ORIGIN = 10;
    const CASCADE_SLOP = CASCADE_STEP / 2;

    const occupied = this.deckState.panes.map((pane) => pane.position);
    const slotTaken = (x: number, y: number): boolean =>
      occupied.some((p) => Math.abs(p.x - x) < CASCADE_SLOP && Math.abs(p.y - y) < CASCADE_SLOP);

    for (let i = 0; ; i += 1) {
      const x = CASCADE_ORIGIN + CASCADE_STEP * i;
      const y = CASCADE_ORIGIN + CASCADE_STEP * i;

      // Walked off the canvas before finding a gap: restart the cascade
      // at the prime slot (the next card sits atop the first one).
      if (x + stackSize.width > canvasWidth || y + stackSize.height > canvasHeight) {
        return { x: CASCADE_ORIGIN, y: CASCADE_ORIGIN };
      }

      if (!slotTaken(x, y)) {
        return { x, y };
      }
    }
  }

  // ---- Layout Persistence ----

  /**
   * Fire-and-forget `putFocusedCardId` with a test-mode bypass. See
   * Test-mode tugbank write semantics and [D02]: every tugbank write is
   * wrapped so test-mode sessions never leak state into tugbank.
   *
   * Named wrapper (rather than a literal `if (this.testMode) return;
   * putFocusedCardId(id);` at each call site) keeps a single
   * implementation per wrapped write family while still covering every
   * live caller.
   *
   * `__tugPersistInTestMode`
   * is the explicit escape hatch for cold-boot harness tests: when
   * true, the test-mode bypass is skipped and the write goes
   * through. Tests that opt in pair this with a per-test
   * `TUGBANK_PATH` so pollution of the user's real tugbank is
   * impossible.
   */
  private putFocusedCardIdGuarded(focusedCardId: string): void {
    if (this.testMode && !shouldPersistInTestMode()) return;
    putFocusedCardId(focusedCardId);
  }

  /**
   * `putLayout` with a test-mode bypass. Resolves the write's success
   * flag, or `true` under the bypass — a suppressed write is not a
   * failed one, and teardown callers read this to decide whether the
   * layout actually landed. See {@link putFocusedCardIdGuarded} for
   * the `__tugPersistInTestMode` escape hatch.
   */
  private putLayoutGuarded(layout: object): Promise<boolean> {
    if (this.testMode && !shouldPersistInTestMode()) return Promise.resolve(true);
    return putLayout(layout);
  }

  /**
   * `putCardState` with a test-mode bypass. Resolves the write's
   * success flag, or `true` under the bypass so `flushDirtyCardStates`
   * can gather the batch without special-casing the empty-network
   * branch. See {@link putFocusedCardIdGuarded} for the
   * `__tugPersistInTestMode` escape hatch.
   */
  private putCardStateGuarded(
    cardId: string,
    bag: CardStateBag,
    options?: { keepalive?: boolean; sync?: boolean },
  ): Promise<boolean> {
    if (this.testMode && !shouldPersistInTestMode()) return Promise.resolve(true);
    return putCardState(cardId, bag, options);
  }

  /**
   * The Lens side carried by the retired app-wide preference, or `undefined`
   * when the user never set one.
   *
   * The side lives in the layout blob now. A user who set the old preference
   * but whose blob predates the record would otherwise have their choice
   * silently reset, so it is read once here and passed to `deserialize` as
   * the last-resort fallback. Nothing writes this key any more, and the value
   * persists into the layout blob on the next save.
   */
  private readLegacyLensSide(): SidebarSide | undefined {
    const client = getTugbankClient();
    if (!client) return undefined;
    const entry = client.get("dev.tugtool.lens", "anchorSide");
    if (!entry || entry.kind !== "string") return undefined;
    return isSidebarSide(entry.value) ? entry.value : undefined;
  }

  private loadLayout(): DeckState {
    const canvasWidth = this.container.clientWidth || 800;
    const canvasHeight = this.container.clientHeight || 600;
    const fallbackSidebarSide = this.readLegacyLensSide() ?? DEFAULT_SIDEBAR_SIDE;

    let state: DeckState | null = null;

    if (this.initialLayout !== null) {
      try {
        const json = JSON.stringify(this.initialLayout);
        state = deserialize(json, canvasWidth, canvasHeight, fallbackSidebarSide);
      } catch (e) {
        console.warn("DeckManager: failed to deserialize initialLayout from API, falling back", e);
      }
      this.initialLayout = null;
    }

    if (state === null) {
      state = buildDefaultLayout(fallbackSidebarSide);
      this.factoryFresh = this.bootStateHonored;
    }

    return this.filterRegisteredCards(state);
  }

  private saveLayout(): Promise<boolean> {
    const serialized = serialize(this.deckState);
    return this.putLayoutGuarded(serialized);
  }

  private scheduleSave(): void {
    if (this.batchDepth > 0) {
      // Held with the notify, and re-armed once on the way out — the
      // gesture's final state is the only one worth persisting.
      this.batchPendingSave = true;
      return;
    }
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveLayout();
      this.saveTimer = null;
    }, SAVE_DEBOUNCE_MS);
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
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveLayout();
    }

    if (this.cardStateSaveTimer !== null) {
      window.clearTimeout(this.cardStateSaveTimer);
      this.cardStateSaveTimer = null;
      this.flushDirtyCardStates();
    }

    if (this.reactRoot) {
      this.reactRoot.unmount();
      this.reactRoot = null;
    }
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("beforeunload", this.handleBeforeUnload);

    this.lifecycleCascade.dispose();
  }
}
