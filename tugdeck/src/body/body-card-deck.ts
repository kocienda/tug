/**
 * The deck a body page's one card sees, and the deck a listing card sees.
 *
 * A card mounted in a body runs the same code it runs in the shell: it reads
 * the deck through `useCardDeck()` and `getCardDeck()`, observes its own
 * activation, keeps its state bag through the save callbacks and assemblers,
 * and asks the deck to reserve sheet height, add a card or close it. Nothing
 * in the card learns it is in a body. {@link createBodyCardDeck} answers that
 * whole surface (`CardDeck`) for one card, and every member acts:
 *
 * - **A read** answers from a replica or from the page's own state. The
 *   snapshot is a synthesized one-pane deck holding the card, folded and
 *   arriving as the shell's `card.context` says, with the pane active when
 *   the deck's first responder is this card.
 * - **The page's own machinery.** Card state, component state, assemblers,
 *   save callbacks, activation callbacks, host roots, engine hooks and
 *   lifecycle observers are the deck's own, run here over this card alone.
 *   The card's bag is read and written by this page; the shell never writes
 *   a body card's bag.
 * - **An ask of the arrangement** is a declared action or request to the
 *   shell: the reservations as `card.reservations`; activation, its own close
 *   and a sibling as `card.activate`, `card.close` and `card.addSibling`; a
 *   reveal as `pane.revealCard`; a card added, a singleton shown and the live
 *   sessions interrupted as `deck.addCard`, `deck.showSingletonCard` and
 *   `deck.interruptLiveSessions`. A card added takes an id minted here, so
 *   the caller holds it before the card lands.
 *
 * A card that lists or moves the whole deck — a registration with
 * `bodyDeck: "arrangement"` — also gets {@link createDeckView}: its snapshot,
 * workspaces and band facts are the shell's own, read from the arrangement
 * replicas, and the deck calls it makes go to the shell as the `deck.*`
 * actions. A card that follows another (`bodyFollows`) reads the followed
 * card the shell names ({@link BodyCardDeck.applyFollowed}).
 *
 * @module body/body-card-deck
 */

import { cardActivate, cardAddSibling, cardClose } from "../bus/declarations/verbs";
import { NO_CARD_CONTEXT, type CardContextValue, type CardReservationsValue } from "../bus/declarations/card";
import {
  deckActivateCard,
  deckActivateSpace,
  deckAddCard,
  deckChooseSpaceTheme,
  deckInterruptLiveSessions,
  deckMoveCardToSpace,
  deckPreviewFlowOffset,
  deckRenameSpace,
  deckReorderSpaces,
  deckSetFlowOffset,
  deckShowSingletonCard,
  type ArrangementDeckValue,
  type ArrangementSpaces,
} from "../bus/declarations/arrangement";
import { paneRevealCard } from "../bus/declarations/pane";
import type { StoreView } from "../bus/shared-store";
import type { EngineHooks } from "../deck-manager-store";
import type { CardDeck, DeckView } from "../card-deck";
import type { CardStateBag, DeckState, TugPaneState } from "../layout-tree";
import { NO_SPACES, type SpacesSnapshot } from "../spaces";
import type { CommitLanding, SaveCallbackSource } from "../deck-trace";
import type { CardAssembler } from "../card-state-orchestrator";
import { CardStateOrchestrator } from "../card-state-orchestrator";
import { CardStateCache, type CardStateCacheDeps } from "../card-state-cache";
import { ComponentStateRegistries, EngineHookRegistry } from "../engine-hooks";
import type { ComponentStatePreservationRegistry } from "../components/tugways/component-state-preservation-registry";
import { CardLifecycle, type CardLifecycleObserver } from "../lib/card-lifecycle";
import type { SpaceLayerShownSource } from "../components/chrome/space-layer";
import { DEFAULT_SIDEBAR_SIDE } from "../lib/layout-imposer";
import { applyBagFocus } from "../focus-transfer";
import { tugDevLogStore } from "../lib/tug-dev-log-store/tug-dev-log-store";
import { arrangementSnapshot } from "../lib/body-arrangement";

/** How long a body waits for the shell to say which live sessions it interrupted ([L33]). */
export const INTERRUPT_LIVE_SESSIONS_HORIZON_MS = 10_000;

/** The pane id a body's card stands in — also its `CardHost`'s `hostStackId`. */
export function bodyPaneId(cardId: string): string {
  return `body-pane-${cardId}`;
}

/** What the card deck needs from the page it runs in. */
export interface BodyCardDeckOptions {
  cardId: string;
  /** The card's registry component id. */
  componentId: string;
  /** Say the room the card asks of its pane (`card.reservations`), whole, on every change. */
  reserve?: (reservations: CardReservationsValue) => void;
  /** Write the card's bag durably (`settings-api`'s `putCardState`, guarded in test mode). */
  putCardState: CardStateCacheDeps["putCardState"];
  /** The card's bag as tugbank holds it at boot, if any. */
  initialBag?: CardStateBag;
}

/** The shell's arrangement as an arrangement card reads it: the live deck and band, and the workspaces. */
export interface BodyArrangement extends ArrangementDeckValue {
  spaces: ArrangementSpaces;
}

/** Build the deck this page's card sees. */
export function createBodyCardDeck(options: BodyCardDeckOptions): BodyCardDeck {
  return new BodyCardDeck(options);
}

/**
 * The card deck, with the page's own handles beside it: `applyContext`,
 * `applyFollowed`, `revealLayer`, `setHasFocus`, `saveNow`, `cardLifecycle`
 * and `layerShownSource` belong to `body-main.ts`, not to the card.
 */
export class BodyCardDeck implements CardDeck {
  readonly cardId: string;
  private readonly componentId: string;
  private readonly reserve: (reservations: CardReservationsValue) => void;
  private reservations: CardReservationsValue = { sheetPx: null, openingBidPx: null };
  private context: CardContextValue = NO_CARD_CONTEXT;
  /** Whether a context from the shell has arrived: the first one sets the geometry baseline. */
  private contextArrived = false;
  /** The card a following card follows, as the shell names it. */
  private followedCardId: string | null = null;
  /** The shell's arrangement, for an arrangement card, once its deck has arrived ({@link createDeckView}). */
  private arrangement: BodyArrangement | null = null;
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
  readonly cardLifecycle: CardLifecycle;

  /**
   * Whether this body's layer reads shown. False from mount — the body's
   * container is hidden until it is ready, so the card's entrance fade
   * declines and the host's fade is the only ramp — until the page is about
   * to post ready; then whatever `card.context` says.
   */
  private layerShown = false;
  private readonly layerListeners = new Set<() => void>();
  readonly layerShownSource: SpaceLayerShownSource;

  constructor(options: BodyCardDeckOptions) {
    this.cardId = options.cardId;
    this.componentId = options.componentId;
    this.reserve = options.reserve ?? (() => {});
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
   * deactivation when the deck's first responder turned to or from it, and
   * its resize, then its move, when the shell's count of either rose.
   */
  applyContext(next: CardContextValue): void {
    const prev = this.context;
    const baseline = !this.contextArrived;
    this.contextArrived = true;
    this.context = next;
    if (
      prev.folded !== next.folded ||
      prev.arriving !== next.arriving ||
      prev.firstResponderCardId !== next.firstResponderCardId ||
      prev.railSide !== next.railSide
    ) {
      this.deckState = this.synthesize();
      this.notify();
    }
    // A warm workspace's card its first visit will make key is key here
    // while it stands parked (`parkedKey`): an unbound Session card raises
    // its picker, so the visit finds it presented and claimed. The visit
    // names it first responder, which it already was here, so it is not
    // activated a second time. Its bag's focus waits for that: focus taken
    // in a parked page asks the shell to activate a card nobody can see.
    const wasFirst = prev.firstResponderCardId === this.cardId;
    const isFirst = next.firstResponderCardId === this.cardId;
    const wasKey = wasFirst || prev.parkedKey === true;
    const isKey = isFirst || next.parkedKey === true;
    if (isKey && !wasKey) {
      this.cardLifecycle.notifyCardDidActivate(this.cardId);
    } else if (wasKey && !isKey) {
      this.cardLifecycle.notifyCardDidDeactivate(this.cardId);
    }
    if (isFirst && !wasFirst) applyBagFocus(this.cardId, this);
    // The shell counts the moves and resizes its deck commits for the card,
    // which its delegates hear here, where its content is. The first context
    // a page reads is the baseline: what moved before it is not news.
    if (!baseline) {
      if (next.geometry.resizes > prev.geometry.resizes) this.cardLifecycle.notifyCardDidResize(this.cardId);
      if (next.geometry.moves > prev.geometry.moves) this.cardLifecycle.notifyCardDidMove(this.cardId);
    }
    if (this.layerShown || prev.layerShown !== next.layerShown) {
      this.setLayerShown(next.layerShown);
    }
  }

  /** The page is about to post ready: from here the layer reads as the shell says. */
  revealLayer(): void {
    this.setLayerShown(true);
  }

  /** The shell's last `card.context`. */
  getContext(): CardContextValue {
    return this.context;
  }

  private setLayerShown(shown: boolean): void {
    if (this.layerShown === shown) return;
    this.layerShown = shown;
    for (const listener of [...this.layerListeners]) listener();
  }

  /**
   * Take the shell's arrangement, for an arrangement card: the deck view
   * hands it over whenever a replica moved, and the snapshot becomes the
   * shell's deck with this card's pane re-keyed.
   */
  showArrangement(arrangement: BodyArrangement): void {
    this.arrangement = arrangement;
    this.deckState = this.synthesize();
    this.notify();
  }

  /** Take the card the shell says this following card follows. */
  applyFollowed(cardId: string | null): void {
    if (cardId === this.followedCardId) return;
    this.followedCardId = cardId;
    this.deckState = this.synthesize();
    this.notify();
  }

  private synthesize(): DeckState {
    const paneId = bodyPaneId(this.cardId);
    if (this.arrangement !== null) {
      return {
        ...arrangementSnapshot(this.arrangement.deck, this.cardId, paneId),
        hasFocus: typeof document !== "undefined" ? document.hasFocus() : true,
      };
    }
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

  // ---- The snapshot ----

  subscribe = (callback: (landing: CommitLanding) => void): (() => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  // A body's deck tells its subscribers on the commit's own task, so the
  // sync door and the deferred one are the same door, and nothing is ever
  // pending for a flush to deliver.
  subscribeSync = (callback: (landing: CommitLanding) => void): (() => void) =>
    this.subscribe(callback);
  flushPendingNotify = (): void => {};
  getSnapshot = (): DeckState => this.deckState;
  // Nothing departs from a one-card deck, so its picture is its snapshot.
  getPicture = (): DeckState => this.deckState;
  getVersion = (): number => this.version;
  getFirstResponderCardId = (): string | null => this.context.firstResponderCardId;
  /** The card is a warm workspace's that its first visit will make key ({@link applyContext}). */
  isParkedKey = (cardId: string): boolean => cardId === this.cardId && this.context.parkedKey === true;
  /**
   * `CardLifecycleStore`: the card is this deck's focused card exactly when
   * it is the whole deck's first responder, or the key card its warm
   * workspace's first visit will make it (`parkedKey`). An activation
   * observer's initial sync reads this, so a card that is not the key card
   * must not be told it was activated by subscribing — and a parked key card
   * whose picker subscribes after its context came is.
   */
  getFocusedCardId = (): string | null =>
    this.context.firstResponderCardId === this.cardId || this.context.parkedKey === true ? this.cardId : null;
  /**
   * The card a following card follows: the last key card that is not it,
   * which only the shell's focus manager knows, so the shell says it in the
   * card's context. `useTrackFollowedCard` reads this in a body.
   */
  getFollowedCardId = (): string | null => this.followedCardId;
  /**
   * The edge the card stands pinned to when it is a rail, which the body's
   * page wears so it paints the rail's surface rather than a content card's;
   * null for a content card or a rail dragged loose.
   */
  getRailSide = (): "left" | "right" | null => this.context.railSide ?? null;
  /**
   * The workspace holding `cardId`. A card's own is its context's; an
   * arrangement card lists every workspace's, so a card of a parked one is
   * found in that workspace's deck — the read that lets the Cards card draw a
   * parked Session card from the bindings ledger (`cardIdentity`'s `parked`).
   */
  spaceOf = (cardId: string): string | null => {
    const arrangement = this.arrangement;
    if (arrangement === null || cardId === this.cardId) return this.context.spaceId;
    if (arrangement.deck.cards.some((c) => c.id === cardId)) return arrangement.spaces.activeSpaceId;
    for (const [spaceId, deck] of Object.entries(arrangement.spaces.decks)) {
      if (deck.cards.some((c) => c.id === cardId)) return spaceId;
    }
    return null;
  };

  // ---- Lifecycle ----

  observeCardDidFinishConstruction = (cardId: string | null, callback: CardLifecycleObserver) =>
    this.cardLifecycle.observeCardDidFinishConstruction(cardId, callback);
  observeCardDidActivate = (cardId: string | null, callback: CardLifecycleObserver) =>
    this.cardLifecycle.observeCardDidActivate(cardId, callback);
  observeCardDidDeactivate = (cardId: string | null, callback: CardLifecycleObserver) =>
    this.cardLifecycle.observeCardDidDeactivate(cardId, callback);
  observeCardWillBeginDestruction = (cardId: string | null, callback: CardLifecycleObserver) =>
    this.cardLifecycle.observeCardWillBeginDestruction(cardId, callback);
  observeCardDidMove = (cardId: string | null, callback: CardLifecycleObserver) =>
    this.cardLifecycle.observeCardDidMove(cardId, callback);
  observeCardDidResize = (cardId: string | null, callback: CardLifecycleObserver) =>
    this.cardLifecycle.observeCardDidResize(cardId, callback);
  setHasFocus = (value: boolean): void => {
    if (this.deckState.hasFocus === value) return;
    this.deckState = { ...this.deckState, hasFocus: value };
    this.notify();
  };

  // ---- Card state ----

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

  // ---- Focus channels ----

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

  // ---- Asks of the arrangement, which is the shell's ----

  setSheetReservation = (_memberId: string, height: number | null): void => {
    this.reservations = { ...this.reservations, sheetPx: height };
    this.reserve(this.reservations);
  };
  setOpeningBid = (_memberId: string, height: number | null): void => {
    this.reservations = { ...this.reservations, openingBidPx: height };
    this.reserve(this.reservations);
  };
  // An arrangement card raising another card — the Layout miniature's press,
  // a Cards row — names that card to the shell; activating this card itself
  // is the body's own `activate`.
  activateCard = (cardId: string, opts?: { reveal?: boolean }): void => {
    if (cardId !== this.cardId && this.arrangement !== null) {
      deckActivateCard.dispatch({ cardId, reveal: opts?.reveal });
      return;
    }
    cardActivate.dispatch({ reveal: opts?.reveal === false ? false : undefined });
  };
  focusCard = (_cardId: string): void => cardActivate.dispatch({ reveal: undefined });
  removeCard = (_paneId: string, _cardId: string): void => cardClose.dispatch({});
  handlePaneClosed = (_paneId: string): void => cardClose.dispatch({});
  // The new card is the shell's; its id is not known here, and the pane's
  // `ADD_TAB` handler — the one caller — never reads it.
  addCardToPane = (_paneId: string, componentId: string, _initialContent?: unknown): string | null => (
    cardAddSibling.dispatch({ componentId }), null
  );
  /** The shell slides the strip this card's pane rides; it answers only for a card of the sender's pane. */
  revealCard = (cardId: string): void => paneRevealCard.dispatch({ cardId });
  /**
   * Mint the new card's id here and hand it to the shell with the ask, so
   * the caller can act on the card at once — spawn its session, flash its
   * pane — as it does in the shell.
   */
  addCard = (
    componentId: string,
    initialContent?: unknown,
    options?: { origin?: string | null; opening?: "bound"; cardId?: string },
  ): string | null => {
    const cardId = options?.cardId ?? crypto.randomUUID();
    deckAddCard.dispatch({
      cardId,
      componentId,
      initialContent,
      origin: options?.origin,
      opening: options?.opening,
    });
    return cardId;
  };
  // The reused card's id is the shell's, and no caller reads it.
  showSingletonCard = (componentId: string): string | null => (
    deckShowSingletonCard.dispatch({ componentId }), null
  );
  interruptLiveSessions = async (): Promise<{ interrupted: string[]; unacknowledged: string[] }> => {
    const result = await deckInterruptLiveSessions.ask({}, { horizon: { ms: INTERRUPT_LIVE_SESSIONS_HORIZON_MS } });
    if (result.ok) return result.value;
    tugDevLogStore.warn("body", `deck.interruptLiveSessions: ${result.reason}`);
    return { interrupted: [], unacknowledged: [] };
  };
}

/** A replica as the deck view reads it. */
type Replica<T> = Pick<StoreView<T>, "getSnapshot" | "subscribe">;

/** The arrangement replicas an arrangement card's page follows. */
export interface ArrangementReplicas {
  deck: Replica<ArrangementDeckValue | null>;
  spaces: Replica<ArrangementSpaces>;
}

/**
 * The deck an arrangement card sees: the card deck's own members, read live
 * from it, and the spaces, bands and run heights from the replicas, which it
 * follows from here on. A replica keeps its object until its value moves, so
 * identity is the change: a moved deck or band re-synthesizes the card
 * deck's snapshot, and moved workspaces rebuild the spaces snapshot too.
 */
export function createDeckView(cardDeck: BodyCardDeck, replicas: ArrangementReplicas): DeckView {
  let arrangement: BodyArrangement | null = null;
  let spacesSnapshot: SpacesSnapshot = NO_SPACES;
  const spacesListeners = new Set<() => void>();

  const apply = (): void => {
    const deck = replicas.deck.getSnapshot();
    const spaces = replicas.spaces.getSnapshot();
    if (deck === null) return;
    const prev = arrangement;
    if (prev !== null && prev.spaces === spaces && prev.deck === deck.deck && prev.bandWidth === deck.bandWidth &&
      prev.columnRunHeight === deck.columnRunHeight && prev.railRunHeight === deck.railRunHeight) {
      return;
    }
    arrangement = { ...deck, spaces };
    const spacesMoved = prev?.spaces !== spaces;
    if (spacesMoved) {
      spacesSnapshot = {
        spaces: spaces.spaces,
        activeSpaceId: spaces.activeSpaceId,
        mountedSpaceIds: spaces.mountedSpaceIds,
        warmSpaceIds: [],
        mountedDecks: new Map(
          spaces.mountedSpaceIds
            .filter((id) => id !== spaces.activeSpaceId && spaces.decks[id] !== undefined)
            .map((id) => [id, spaces.decks[id]]),
        ),
      };
    }
    cardDeck.showArrangement(arrangement);
    if (spacesMoved) {
      for (const listener of [...spacesListeners]) listener();
    }
  };

  // The card deck's members are its own arrow properties, bound to it, so a
  // view whose prototype is the card deck reads every one of them live.
  const view: DeckView = Object.assign(Object.create(cardDeck) as CardDeck, {
    getBandWidth: (): number | null => arrangement?.bandWidth ?? null,
    getColumnRunHeight: (): number | null => arrangement?.columnRunHeight ?? null,
    getRailRunHeight: (): number | null => arrangement?.railRunHeight ?? null,
    setFlowOffset: (offset: number, landing?: CommitLanding): void => deckSetFlowOffset.dispatch({ offset, landing }),
    previewFlowOffset: (offset: number): void => deckPreviewFlowOffset.dispatch({ offset }),
    subscribeSpaces: (callback: () => void): (() => void) => {
      spacesListeners.add(callback);
      return () => {
        spacesListeners.delete(callback);
      };
    },
    getSpacesSnapshot: (): SpacesSnapshot => spacesSnapshot,
    getSpaceDeck: (spaceId: string): DeckState | null => {
      if (arrangement === null) return null;
      if (spaceId === arrangement.spaces.activeSpaceId) return cardDeck.getSnapshot();
      return arrangement.spaces.decks[spaceId] ?? null;
    },
    activateSpace: (spaceId: string): void => deckActivateSpace.dispatch({ spaceId }),
    renameSpace: (spaceId: string, name: string): void => deckRenameSpace.dispatch({ spaceId, name }),
    chooseSpaceTheme: (spaceId: string, theme: string): void => deckChooseSpaceTheme.dispatch({ spaceId, theme }),
    spaceHoldsLiveSessions: (spaceId: string): number => arrangement?.spaces.liveSessions[spaceId] ?? 0,
    spaceCardCount: (spaceId: string): number => arrangement?.spaces.cardCounts[spaceId] ?? 0,
    reorderSpaces: (order: readonly string[]): void => deckReorderSpaces.dispatch({ order: [...order] }),
    /**
     * The move is the shell's to make or refuse; a body hands it over and
     * answers that it did, and the shell reports a refusal itself.
     */
    moveCardToSpace: (cardId: string, spaceId: string): boolean => {
      deckMoveCardToSpace.dispatch({ cardId, spaceId });
      return true;
    },
  });

  replicas.deck.subscribe(apply);
  replicas.spaces.subscribe(apply);
  apply();
  return view;
}
