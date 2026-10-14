/**
 * The deck a body page's one card sees.
 *
 * A card mounted in a body runs the same code it runs in the shell: it reads
 * the deck through `useDeckManager()` and `getDeckStore()`, observes its own
 * activation, keeps its state bag through the save callbacks and assemblers,
 * and asks the deck to reserve sheet height or close it. Nothing in the card
 * learns it is in a body. This class answers that whole surface for one card:
 *
 * - **Real, here.** The snapshot is a synthesized one-pane deck holding the
 *   card, folded and arriving as the shell's last `card-context` says, with
 *   the pane active when the deck's first responder is this card. Card state,
 *   component state, assemblers, save callbacks, activation callbacks, host
 *   roots, engine hooks and lifecycle observers are the deck's own machinery,
 *   run here over this card alone. The card's bag is read and written by this
 *   page — the shell never writes a body card's bag.
 * - **Forwarded.** What a card asks of the deck's arrangement — a sheet
 *   reservation, an opening bid, activation, its own close — goes to the
 *   shell as `card-advice`.
 * - **Inert.** Every layout, rail, flow, column, space and add verb is the
 *   shell's. Here it does nothing, answers null or false, and says so once.
 *
 * @module body/body-deck-bridge
 */

import type { CardAdvice, CardContext } from "@tugproto/bus";
import type { EngineHooks, IDeckManagerStore, MovePaneOptions } from "../deck-manager-store";
import type { CardStateBag, DeckState, TugPaneState } from "../layout-tree";
import type { SpacesSnapshot } from "../spaces";
import type { CommitLanding, SaveCallbackSource } from "../deck-trace";
import type { CardAssembler } from "../card-state-orchestrator";
import { CardStateOrchestrator } from "../card-state-orchestrator";
import { CardStateCache, type CardStateCacheDeps } from "../card-state-cache";
import { ComponentStateRegistries, EngineHookRegistry } from "../engine-hooks";
import type { ComponentStatePreservationRegistry } from "../components/tugways/component-state-preservation-registry";
import { CardLifecycle, type CardLifecycleObserver } from "../lib/card-lifecycle";
import type { SpaceLayerShownSource } from "../components/chrome/space-layer";
import type { SlotAssignment } from "../layout-imposition";
import type { RailWidthLimits } from "../lib/rail-width";
import type {
  ColumnMoveTarget,
  ContentWidth,
  FlowBandEdges,
  SidebarSide,
} from "../lib/layout-imposer";
import { DEFAULT_SIDEBAR_SIDE } from "../lib/layout-imposer";
import { applyBagFocus } from "../focus-transfer";
import { tugDevLogStore } from "../lib/tug-dev-log-store/tug-dev-log-store";

/** The pane id a body's card stands in — also its `CardHost`'s `hostStackId`. */
export function bodyPaneId(cardId: string): string {
  return `body-pane-${cardId}`;
}

/** What the bridge needs from the page it runs in. */
export interface BodyDeckBridgeOptions {
  cardId: string;
  /** The card's registry component id. */
  componentId: string;
  /** Send one piece of advice to the shell. */
  advise: (advice: CardAdvice) => void;
  /** Write the card's bag durably (`settings-api`'s `putCardState`, guarded in test mode). */
  putCardState: CardStateCacheDeps["putCardState"];
  /** The card's bag as tugbank holds it at boot, if any. */
  initialBag?: CardStateBag;
}

const NO_CONTEXT: CardContext = {
  folded: false,
  arriving: false,
  firstResponderCardId: null,
  layerShown: false,
  spaceId: null,
};

const NO_SPACES: SpacesSnapshot = {
  spaces: [],
  activeSpaceId: "",
  mountedSpaceIds: [],
  mountedDecks: new Map(),
};

export class BodyDeckBridge implements IDeckManagerStore {
  readonly cardId: string;
  private readonly componentId: string;
  private readonly advise: (advice: CardAdvice) => void;
  private context: CardContext = NO_CONTEXT;
  private deckState: DeckState;
  private version = 0;
  private readonly listeners = new Set<(landing: CommitLanding) => void>();
  private readonly cardStates: CardStateCache;
  private readonly componentStateRegistries = new ComponentStateRegistries();
  private readonly orchestrator = new CardStateOrchestrator((cardId) =>
    this.componentStateRegistries.peek(cardId),
  );
  private readonly engineHooks = new EngineHookRegistry();
  private readonly activationCallbacks = new Map<string, () => void>();
  private readonly deactivationCallbacks = new Map<string, () => void>();
  private readonly cardHostRoots = new Map<string, HTMLElement>();
  private readonly warned = new Set<string>();
  readonly cardLifecycle: CardLifecycle;

  /**
   * Whether this body's layer reads shown. False from mount — the body's
   * container is hidden until it is ready, so the card's entrance fade
   * declines and the host's fade is the only ramp — until the page is about
   * to post ready; then whatever `card-context` says.
   */
  private layerShown = false;
  private readonly layerListeners = new Set<() => void>();
  readonly layerShownSource: SpaceLayerShownSource;

  constructor(options: BodyDeckBridgeOptions) {
    this.cardId = options.cardId;
    this.componentId = options.componentId;
    this.advise = options.advise;
    this.cardStates = new CardStateCache(
      { putCardState: options.putCardState },
      options.initialBag === undefined
        ? undefined
        : new Map([[options.cardId, options.initialBag]]),
    );
    this.deckState = this.synthesize();
    this.cardLifecycle = new CardLifecycle(this);
    const layerListeners = this.layerListeners;
    this.layerShownSource = {
      spaceId: null,
      get: () => this.layerShown,
      subscribe: (callback) => {
        layerListeners.add(callback);
        return () => layerListeners.delete(callback);
      },
    };
  }

  // ---- The shell's facts ----

  /**
   * Take the shell's latest word on this card. Re-synthesizes the deck when a
   * fact the snapshot carries moved, and fires the card's activation or
   * deactivation when the deck's first responder turned to or from it.
   */
  applyContext(next: CardContext): void {
    const prev = this.context;
    this.context = next;
    if (
      prev.folded !== next.folded ||
      prev.arriving !== next.arriving ||
      prev.firstResponderCardId !== next.firstResponderCardId
    ) {
      this.deckState = this.synthesize();
      this.notify();
    }
    const wasKey = prev.firstResponderCardId === this.cardId;
    const isKey = next.firstResponderCardId === this.cardId;
    if (isKey && !wasKey) {
      this.cardLifecycle.notifyCardDidActivate(this.cardId);
      applyBagFocus(this.cardId, this);
    } else if (wasKey && !isKey) {
      this.cardLifecycle.notifyCardDidDeactivate(this.cardId);
    }
    if (this.layerShown || prev.layerShown !== next.layerShown) {
      this.setLayerShown(next.layerShown);
    }
  }

  /** The page is about to post ready: from here the layer reads as the shell says. */
  revealLayer(): void {
    this.setLayerShown(true);
  }

  /** The shell's last `card-context`. */
  getContext(): CardContext {
    return this.context;
  }

  private setLayerShown(shown: boolean): void {
    if (this.layerShown === shown) return;
    this.layerShown = shown;
    for (const listener of [...this.layerListeners]) listener();
  }

  private synthesize(): DeckState {
    const paneId = bodyPaneId(this.cardId);
    const pane: TugPaneState = {
      id: paneId,
      position: { x: 0, y: 0 },
      size: { width: 0, height: 0 },
      cardIds: [this.cardId],
      activeCardId: this.cardId,
      title: "",
      acceptsFamilies: [],
      ...(this.context.folded ? { folded: true as const } : {}),
    };
    return {
      cards: [{ id: this.cardId, componentId: this.componentId, title: "", closable: true }],
      panes: [pane],
      ...(this.context.firstResponderCardId === this.cardId ? { activePaneId: paneId } : {}),
      imposition: { sidebars: { dashes: { side: DEFAULT_SIDEBAR_SIDE } } },
      hasFocus: typeof document !== "undefined" ? document.hasFocus() : true,
      ...(this.context.arriving ? { arriving: { [paneId]: true as const } } : {}),
    };
  }

  private notify(landing: CommitLanding = "cut"): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener(landing);
  }

  private inert(method: string): void {
    if (this.warned.has(method)) return;
    this.warned.add(method);
    tugDevLogStore.warn("body", `${method} is the shell's`);
  }

  // ---- Real, local: the snapshot ----

  subscribe = (callback: (landing: CommitLanding) => void): (() => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  subscribeSync = (callback: (landing: CommitLanding) => void): (() => void) =>
    this.subscribe(callback);
  flushPendingNotify = (): void => {};
  getSnapshot = (): DeckState => this.deckState;
  getPicture = (): DeckState => this.deckState;
  batchGesture = <T,>(fn: () => T): T => fn();
  getVersion = (): number => this.version;
  getFirstResponderCardId = (): string | null => this.context.firstResponderCardId;
  /**
   * `CardLifecycleStore`: the card is this deck's focused card exactly when
   * it is the whole deck's first responder. An activation observer's
   * initial sync reads this, so a card that is not the key card must not
   * be told it was activated by subscribing.
   */
  getFocusedCardId = (): string | null =>
    this.context.firstResponderCardId === this.cardId ? this.cardId : null;

  // ---- Real, local: lifecycle ----

  observeCardDidFinishConstruction = (cardId: string | null, callback: CardLifecycleObserver) =>
    this.cardLifecycle.observeCardDidFinishConstruction(cardId, callback);
  observeCardDidActivate = (cardId: string | null, callback: CardLifecycleObserver) =>
    this.cardLifecycle.observeCardDidActivate(cardId, callback);
  observeCardDidDeactivate = (cardId: string | null, callback: CardLifecycleObserver) =>
    this.cardLifecycle.observeCardDidDeactivate(cardId, callback);
  observeCardWillBeginDestruction = (cardId: string | null, callback: CardLifecycleObserver) =>
    this.cardLifecycle.observeCardWillBeginDestruction(cardId, callback);
  noteCardWillLand = (cardId: string): void => this.cardLifecycle.notifyCardWillLand(cardId);
  noteCardDidLand = (cardId: string): void => this.cardLifecycle.notifyCardDidLand(cardId);
  setHasFocus = (value: boolean): void => {
    if (this.deckState.hasFocus === value) return;
    this.deckState = { ...this.deckState, hasFocus: value };
    this.notify();
  };

  // ---- Real, local: card state ----

  getCardState = (cardId: string): CardStateBag | undefined => this.cardStates.get(cardId);
  setCardState = (cardId: string, bag: CardStateBag): void => this.cardStates.set(cardId, bag);
  flushCardStateNow = (cardId: string): void =>
    this.cardStates.flushNow(cardId, this.captureCardState(cardId));
  suspendCardStateSaves = (): (() => void) => this.cardStates.suspendSaves();
  registerSaveCallback = (id: string, callback: (source?: SaveCallbackSource) => void): void =>
    this.cardStates.registerSaveCallback(id, callback);
  unregisterSaveCallback = (id: string): void => this.cardStates.unregisterSaveCallback(id);
  invokeSaveCallback = (id: string, source?: SaveCallbackSource): void =>
    this.cardStates.invokeSaveCallback(id, source);
  getComponentStatePreservationRegistry = (cardId: string): ComponentStatePreservationRegistry =>
    this.componentStateRegistries.get(cardId);
  peekComponentStatePreservationRegistry = (
    cardId: string,
  ): ComponentStatePreservationRegistry | undefined => this.componentStateRegistries.peek(cardId);
  registerCardAssembler = (cardId: string, assembler: CardAssembler): (() => void) =>
    this.orchestrator.registerAssembler(cardId, assembler);
  captureCardState = (cardId: string, source?: SaveCallbackSource): CardStateBag =>
    this.orchestrator.captureCardState(cardId, source);

  /**
   * Capture the card, flush its bag, and wait for the write — the body's
   * half of a quit, a reload or a teardown. Resolves whether it landed.
   */
  async saveNow(options?: { sync?: boolean }): Promise<boolean> {
    // The card's save callback captures through the orchestrator and stores
    // the bag; a card with none registered has nothing newer to say.
    this.invokeSaveCallback(this.cardId, "manual");
    const results = await this.cardStates.flushDirty({ force: true, sync: options?.sync });
    return results.every((r) => r.ok);
  }

  // ---- Real, local: focus channels ----

  registerActivationCallback = (cardId: string, callback: () => void): (() => void) => {
    this.activationCallbacks.set(cardId, callback);
    return () => {
      if (this.activationCallbacks.get(cardId) === callback) this.activationCallbacks.delete(cardId);
    };
  };
  invokeActivationCallback = (cardId: string, _dispatchedFrom: string): void => {
    this.activationCallbacks.get(cardId)?.();
  };
  registerDeactivationCallback = (cardId: string, callback: () => void): (() => void) => {
    this.deactivationCallbacks.set(cardId, callback);
    return () => {
      if (this.deactivationCallbacks.get(cardId) === callback) this.deactivationCallbacks.delete(cardId);
    };
  };
  invokeDeactivationCallback = (cardId: string, _dispatchedFrom: string): void => {
    this.deactivationCallbacks.get(cardId)?.();
  };
  registerCardHostRoot = (cardId: string, el: HTMLElement | null): void => {
    if (el === null) this.cardHostRoots.delete(cardId);
    else this.cardHostRoots.set(cardId, el);
  };
  peekCardHostRoot = (cardId: string): HTMLElement | null => this.cardHostRoots.get(cardId) ?? null;
  registerEngineHooks = (cardId: string, hooks: EngineHooks): (() => void) =>
    this.engineHooks.register(cardId, hooks);
  invokeEnginePaintMirrorAsActive = (cardId: string): void =>
    this.engineHooks.paintMirrorAsActive(cardId);
  invokeEnginePaintMirrorAsInactive = (cardId: string): void =>
    this.engineHooks.paintMirrorAsInactive(cardId);
  hasEngineHooks = (cardId: string): boolean => this.engineHooks.has(cardId);
  subscribeEngineHooksChange = (cardId: string, listener: () => void): (() => void) =>
    this.engineHooks.subscribeChange(cardId, listener);

  // ---- Forwarded to the shell ----

  setSheetReservation = (_memberId: string, height: number | null): void =>
    this.advise({ advice: "sheet-reservation", heightPx: height });
  setOpeningBid = (_memberId: string, height: number | null): void =>
    this.advise({ advice: "opening-bid", heightPx: height });
  activateCard = (_cardId: string, _opts?: { reveal?: boolean }): void =>
    this.advise({ advice: "activate" });
  focusCard = (_cardId: string): void => this.advise({ advice: "activate" });
  removeCard = (_paneId: string, _cardId: string): void => this.advise({ advice: "close-request" });
  handlePaneClosed = (_paneId: string): void => this.advise({ advice: "close-request" });

  // ---- Inert: the deck's arrangement is the shell's ----

  getBandWidth = (): number | null => (this.inert("getBandWidth"), null);
  getDrawnFlowOffset = (): number | null => null;
  getDrawnFlowVelocity = (): number | null => null;
  setDrawnFlowVelocity = (_v: number | null): void => this.inert("setDrawnFlowVelocity");
  getBandEdges = (): FlowBandEdges | null => null;
  getBandSpan = (): number => 0;
  getColumnRunHeight = (): number | null => null;
  getRailRunHeight = (): number | null => null;
  getSpaceSwitchStartedAt = (): number | null => null;
  getImpositionGestureAt = (): number | null => null;
  setColumnOffset = (_slot: number, _offset: number, _landing?: CommitLanding): void =>
    this.inert("setColumnOffset");
  setRailOffset = (_side: SidebarSide, _offset: number, _landing?: CommitLanding): void =>
    this.inert("setRailOffset");
  setFlowOffset = (_offset: number, _landing?: CommitLanding): void => this.inert("setFlowOffset");
  railWidthLimits = (_side: SidebarSide): RailWidthLimits | null => null;
  setRailWidth = (_side: SidebarSide, _width: number): void => this.inert("setRailWidth");
  previewFlowOffset = (_offset: number): void => this.inert("previewFlowOffset");
  handlePaneMoved = (
    _paneId: string,
    _position: { x: number; y: number },
    _size: { width: number; height: number },
    _opts?: MovePaneOptions,
  ): void => this.inert("handlePaneMoved");
  deselectActiveCard = (): void => this.inert("deselectActiveCard");
  revealCard = (_cardId: string): void => this.inert("revealCard");
  addCard = (
    _componentId: string,
    _initialContent?: unknown,
    _options?: { origin?: string | null; opening?: "bound" },
  ): string | null => (this.inert("addCard"), null);
  showSingletonCard = (_componentId: string): string | null => (this.inert("showSingletonCard"), null);
  centerPane = (_cardId: string): void => this.inert("centerPane");
  sendPaneBehind = (_paneId: string, _belowPaneId: string): void => this.inert("sendPaneBehind");
  showSidebarPane = (_componentId: string): string | null => (this.inert("showSidebarPane"), null);
  hideSidebarPane = (_componentId: string): void => this.inert("hideSidebarPane");
  showSidebarRail = (_side: SidebarSide): string | null => (this.inert("showSidebarRail"), null);
  hideSidebarRail = (_side: SidebarSide): void => this.inert("hideSidebarRail");
  retuneSidebarAllocation = (): void => this.inert("retuneSidebarAllocation");
  setRailShares = (_side: SidebarSide, _shares: Record<string, number>): void =>
    this.inert("setRailShares");
  setRailOrder = (_side: SidebarSide, _order: readonly string[]): void => this.inert("setRailOrder");
  moveSidebarToRail = (_componentId: string, _side: SidebarSide, _index: number): void =>
    this.inert("moveSidebarToRail");
  setColumnShares = (_slot: number, _shares: Record<string, number>): void =>
    this.inert("setColumnShares");
  setColumnOrder = (_slot: number, _order: readonly string[], _movedPaneId?: string): void =>
    this.inert("setColumnOrder");
  movePaneToSlot = (_paneId: string, _slot: number, _index?: number): SlotAssignment => (
    this.inert("movePaneToSlot"), { ok: false }
  );
  assignCardToSlot = (_cardId: string, _slot: number): SlotAssignment => (
    this.inert("assignCardToSlot"), { ok: false }
  );
  moveInColumn = (_paneId: string, _where: ColumnMoveTarget): boolean => (
    this.inert("moveInColumn"), false
  );
  addCardToPane = (_paneId: string, _componentId: string, _initialContent?: unknown): string | null => (
    this.inert("addCardToPane"), null
  );
  setActiveCardInPane = (_paneId: string, _cardId: string): void => this.inert("setActiveCardInPane");
  reorderCardInPane = (_paneId: string, _from: number, _to: number): void =>
    this.inert("reorderCardInPane");
  detachCard = (_paneId: string, _cardId: string, _position: { x: number; y: number }): string | null => (
    this.inert("detachCard"), null
  );
  moveCardToPane = (_source: string, _cardId: string, _target: string, _index: number): void =>
    this.inert("moveCardToPane");
  subscribeSpaces = (_callback: () => void): (() => void) => () => {};
  getSpacesSnapshot = (): SpacesSnapshot => NO_SPACES;
  spaceOf = (_cardId: string): string | null => this.context.spaceId;
  getSpaceDeck = (_spaceId: string): DeckState | null => null;
  activateSpace = (_spaceId: string): void => this.inert("activateSpace");
  createSpace = (_name?: string): string => (this.inert("createSpace"), "");
  renameSpace = (_spaceId: string, _name: string): void => this.inert("renameSpace");
  chooseSpaceTheme = (_spaceId: string, _theme: string): void => this.inert("chooseSpaceTheme");
  duplicateSpace = (_spaceId: string): string | null => (this.inert("duplicateSpace"), null);
  spaceHoldsLiveSessions = (_spaceId: string): number => 0;
  spaceCardCount = (_spaceId: string): number => 0;
  deleteSpace = (_spaceId: string): boolean => (this.inert("deleteSpace"), false);
  reorderSpaces = (_order: readonly string[]): void => this.inert("reorderSpaces");
  moveCardToSpace = (_cardId: string, _spaceId: string): boolean => (
    this.inert("moveCardToSpace"), false
  );
  setPaneWidth = (_paneId: string, _preset: ContentWidth): void => this.inert("setPaneWidth");
  setContentWidth = (_preset: ContentWidth): void => this.inert("setContentWidth");
  toggleBullseye = (_paneId: string): void => this.inert("toggleBullseye");
  getBullseyePaneId = (): string | null => null;
  interruptLiveSessions = async (): Promise<{ interrupted: string[]; unacknowledged: string[] }> => (
    this.inert("interruptLiveSessions"), { interrupted: [], unacknowledged: [] }
  );
  registerDepartureHost = (): (() => void) => () => {};
  landDepartures = (_paneIds?: readonly string[]): void => {};
}
