/**
 * The shell's picture of its body cards, kept current both ways.
 *
 * A body card's content lives in another document, so everything the shell
 * read from the card in its own page arrives instead over the bus, and
 * everything the card read from the deck goes to it the same way:
 *
 * - The host's `onBodyState` moves a card through `bodyCardsStore`; a body
 *   that failed leaves the card to the shell for the rest of the run.
 * - The body owns its card's stores (`card.facts`, `card.holds`,
 *   `card.reservations`, `card.surface`, `card.painted`, …), which the shell
 *   reads as replicas: the facts set the card's title, masthead, identity
 *   and title-bar items, and feed `bodyFactsStore`; the holds answer the
 *   shell's close advisor and fold guard; the reservations claim sheet
 *   reservations and opening bids on the member the card stands as. The
 *   ones a page holds only while it stands clear when the card is detached,
 *   so what the gone page held goes with it. A body activates its card,
 *   adds a sibling to its pane, and closes it (`card.activate`,
 *   `card.addSibling`, `card.close`); a command its own chain did not
 *   answer, and a logout, are the shell's (`command.shell`, `app.logout`).
 * - The shell asks a body two questions that wait on a person in the card:
 *   whether a guarded close goes ahead (`card.closeDecision`), and a question
 *   from outside the turn stream, shown in a Session card's dialog
 *   (`session.ask`, from `pendingAskStore`).
 * - The shell owns the deck's facts (`deck.facts`, `deck.menu`,
 *   `deck.frontmostProject`) and each card's context and crossing
 *   (`card.context`, `card.crossing`) as shared stores (`bus/declarations/`),
 *   set on every change; a body that says hello is sent every one it reads
 *   before anything held for it. Every card's binding and reported phase go
 *   to every body the same way (`deck.cardBindings`, `deck.cardActivities`).
 * - `bodyFocus` goes to the host on every first-responder change, so the
 *   keyboard follows the deck's first responder into a body and out again.
 * - A body card's Tab walk may be split: its own stops in the body, its
 *   chrome's here (none a Session card has: it authors its own folded form,
 *   so it wears no Unfold glyph). A body's walk that runs off an end says
 *   `focus.exit`; the shell lands its own first or last stop of the card,
 *   or with none sends `focus.enter` back at the end the walk came in by.
 *   The shell's walk running off an end goes into the body the same way,
 *   and a step of it while the shell holds none of the card's stops is the
 *   body's. While the shell holds a stop of the card's, it holds the keyboard.
 * - A destroyed card's body is destroyed with it, unsaved: its bag is about
 *   to be swept.
 * - A surface a body card raises past its content box — the Z2 placard —
 *   arrives as `card.surface` and is drawn here, over the deck, where the
 *   in-document card would have drawn it (`shell-surface.ts`); a press in it
 *   or its dismissal goes back as `surface.activate` / `surface.dismissed`.
 * - A command whose owner is the key card goes to the key body when the key
 *   card is one and no shell surface holds the chain ahead of it: the shell's
 *   key-card route (`bus/command-route.ts`), which also takes the shell's
 *   Tab walk off the end of its own stops into the body. A chain action for
 *   a body card's content, a line revealed in its Text card, ⌘J's capture,
 *   a session decided for it after the hand-off, Escape's shrink of the
 *   Cards table and a refusal of its modal hold are each the routed action
 *   that names them (`bus/declarations/verbs.ts`), sent from where the shell
 *   decides them and held by the bus for a body not yet attached.
 * - A card that lists or moves the whole deck (`bodyDeck: "arrangement"`)
 *   reads the shell's arrangement (`arrangement.deck`, `arrangement.spaces`,
 *   `arrangement.cardFacts`), set when the deck, the workspaces, or any
 *   card's title or identity moves; the deck calls it makes are the `deck.*`
 *   actions, which run here. The Cards card reads the bindings cache
 *   (`cards.ledgerBindings`) and holds the layout selection with the shell
 *   (`layout.selection`); a workspace verb the menu asked it to answer goes
 *   to the shown workspace's Cards card as `cards.spaceVerb`. A card that
 *   follows another (`bodyFollows`) reads the followed card — the last key
 *   card that is not it — from `card.followed`.
 *   A devtools body following a body card has that card's session
 *   inspection relayed to it: the shell says the followed card is inspected
 *   (`card.inspected`), so its body publishes `card.inspection`, sets each
 *   following devtools card's `devtools.inspection` from it, and says the
 *   card is not inspected once no devtools body follows it. The
 *   devtools body is also sent this page's dev log (`devtools.logEntries`), the About
 *   body the app identity the host sent this page (`app.info`), and the
 *   Settings body any section reveal parked here (`settings.reveal`).
 * - A body card whose close guard would ask says so (`card.holds`); the
 *   shell then holds a close guard for it that fronts the card and asks the
 *   body's own guard (`card.closeDecision`), so a close here, or a walk over a
 *   workspace, waits on the sheet the body raises in the card it concerns.
 * - A body card held by a modal run says so (`card.holds`); the shell holds
 *   the card in its own `cardModalHoldStore` for as long as the body says,
 *   so the title bar's cluster, ⌘W and the tab × refuse here, and a refusal
 *   asks the body to speak it (`card.refuseHold`). The hold goes with the page.
 *
 * Laws: [L02] (the stores are read through `useSyncExternalStore`), [L22]
 * (advisors read the store directly), [L27] (every registration released),
 * [L33] (a close decision waits on the body's answer, its going away, or —
 * while the body said its guard would not ask — a deadline).
 *
 * @module lib/body-shell
 */

import type { ShellSurface } from "../bus/declarations/card";
import type { TugConnection } from "../connection";
import type { IDeckManagerStore } from "../deck-manager-store";
import type { DeckState } from "../layout-tree";
import { getResponderChainManager } from "../action-registry";
import { answerBodyCommands, dispatchCommand } from "../command-dispatch";
import { enterKeyViewWalk, getFocusManager } from "../components/tugways/focus-manager";
import { TUG_ACTIONS } from "./action-vocabulary";
import { setKeyboardYield } from "./keyboard-yield";
import { getOnScreenTheme, subscribeOnScreenTheme } from "../contexts/theme-provider";
import { cardArrivingOf, cardFoldedOf } from "../deck-store-selectors";
import { keyboardAccessStore } from "../keyboard-access-store";
import { focusRingModalityStore } from "../focus-ring-modality-store";
import { heldModifiers, subscribeModifierLatch } from "../components/tugways/modifier-latch";
import { projectDeckState } from "./host-menu-state";
import { focusTravelDirections } from "./directional-focus";
import { bodyCardsStore } from "./body-cards-store";
import { bodyCommandRoute, keyboardBodyFor, shellResponderAboveCard, shellSurfaceAhead } from "./body-command-route";
import { shellKeyboardHeld, subscribeShellKeyboardHold } from "./shell-keyboard-hold";
import { bodyFactsStore } from "./body-facts-store";
import { bodyBeatsCancelled, bodyBeatsLanded, bodyShown, floorShown } from "./body-placement";
import { registerCardCloseAdvice } from "./card-close-advice";
import { registerCardFoldGuard } from "./card-fold";
import { cardSessionBindingStore, shareCardBinding } from "./card-session-binding-store";
import { cardTitleStore } from "./card-title-store";
import { CARDS_CARD_ID } from "./cards-card-id";
import { cardsSpaceVerbRequest } from "@/components/cards/cards-space-verb-request";
import { requestLogout } from "./logout-store";
import { ShellSurfaceDrawer } from "./shell-surface";
import { askCloseDecision, withdrawCloseDecision } from "./close-decision";
import { pageBus } from "../bus/page-bus";
import { installKeyCardRoute } from "../bus/command-route";
import {
  appLogout,
  cardActivate,
  cardAddSibling,
  cardClose,
  cardRefuseHold,
  commandForCard,
  devtoolsLogEntries,
  focusEnter,
  focusExit,
  settingsReveal,
  surfaceActivate,
  surfaceDismissed,
} from "../bus/declarations/verbs";
import {
  cardContext,
  cardCrossing,
  cardFacts,
  cardHolds,
  cardInspected,
  cardInspection,
  cardPainted,
  cardReservations,
  cardSurface,
  devtoolsInspection,
  type CardContextValue,
  type CardFactsValue,
  type CardHoldsValue,
  type CardReservationsValue,
} from "../bus/declarations/card";
import type { SharedStore } from "../bus/shared-store";
import {
  deckFacts,
  deckFrontmostProject,
  deckMenu,
  type DeckFactsValue,
  type DeckMenuValue,
} from "../bus/declarations/deck";
import type { CrossingMirror } from "./fold-crossing";
import type { BodyIntent } from "../body/body-intent";
import {
  askForBodyAgain,
  bodyIntentOf,
  forgetBodyIntent,
  handOffToBody,
  hostCapabilitiesStore,
  isBodyKind,
  isMountBodyKind,
  postToHost,
  setBodyReloader,
} from "./body-handoff";
import { restorePassCards, restorePassGate, sessionRestoreRegistry } from "./session-restore";
import { spaceBindingsLedgerStore } from "./space-bindings-ledger-store";
import { openingBidForCard } from "./opening-bid";
import { pageZoomStore } from "./page-zoom-store";
import { bodyChordCaptureStore } from "./body-chord-capture-store";
import { sheetReservationMemberIdOf } from "./sheet-reservation";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";
import { getRegistration, isSidebarCard, type CardIdentityFacts } from "../card-registry";
import { cardIdentityElsewhere, liveCardIdentity } from "./card-identity";
import { paneTitleBarItemsStore, type PaneTitleBarItem } from "./pane-title-bar-items-store";
import { isSidebarPinned, sidebarSide, type SidebarSide } from "./layout-imposer";
import {
  projectActivities,
  projectArrangementCardFacts,
  projectArrangementDeck,
  projectArrangementSpaces,
  projectBindings,
} from "./body-arrangement";
import {
  appInfo,
  arrangementCardFacts,
  arrangementDeck,
  arrangementSpaces,
  cardFollowed,
  cardsLedgerBindings,
  cardsSpaceVerb,
  deckActivateCard,
  deckActivateSpace,
  deckCardActivities,
  deckCardBindings,
  deckChooseSpaceTheme,
  deckMoveCardToSpace,
  deckPreviewFlowOffset,
  deckRenameSpace,
  deckReorderSpaces,
  deckSetFlowOffset,
} from "../bus/declarations/arrangement";
import { answerMiniature } from "./miniature-bus";
import { getDropZoneHost } from "./drop-zone-host-registry";
import { flashCardPane } from "./flash-pane-border";
import { shareLayoutSelection } from "./cards-selection-store";
import { registerCardCloseGuard } from "./card-close-guard";
import { cardModalHoldStore } from "./card-modal-hold-store";
import { appInfoStore } from "./app-info-store";
import { registerSettingsRevealConsumer } from "./settings-reveal";
import { frontmostProjectBinding } from "./frontmost-project";
import { motionBreaker } from "./motion-guard/breaker";
import { holdOverviewDraftInShell } from "../components/overview/overview-composer-draft";
import { CROSSING_FRAME_ATTRS, crossingMirrorOf } from "./fold-crossing";
import type { TugDevLogEntry } from "./tug-dev-log-store/types";

/** The kinds the shell relays something of its own to, by their component ids. */
const DEVTOOLS_KIND = "devtools";
const SETTINGS_KIND = "settings";

/**
 * A log entry as the relay carries it: its id left to the receiving page,
 * and data that would not survive the bus (a cycle) reduced to its string.
 */
function relayableLogEntry(entry: TugDevLogEntry): Omit<TugDevLogEntry, "id"> {
  let data = entry.data;
  if (data !== undefined) {
    try {
      JSON.stringify(data);
    } catch {
      data = String(data);
    }
  }
  return {
    timestamp: entry.timestamp,
    level: entry.level,
    source: entry.source,
    message: entry.message,
    ...(data !== undefined ? { data } : {}),
  };
}

/** What the host reports about a body (`window.__tugBridge.onBodyState`). */
interface BodyStateReport {
  cardId?: unknown;
  state?: unknown;
  readyMs?: unknown;
  cause?: unknown;
  /** `floorShown`: how long after the window's reveal began the floor showed. */
  sinceRevealMs?: unknown;
  /** `landed` / `beatsCancelled`: the beat plan the report is about. */
  planId?: unknown;
  /** `landed`: how far past its start the plan reached the host, ms. */
  lateMs?: unknown;
}

function paneOf(state: DeckState, cardId: string): string | null {
  return state.panes.find((p) => p.cardIds.includes(cardId))?.id ?? null;
}

/**
 * How many times the shell asks the host again for a card's body after it
 * fails, before the card stands as a placard with a Reload.
 */
const BODY_RETRIES = 1;

/** `intent` as it was decided, without the bag it was first sent with. */
function withoutBag(intent: BodyIntent | null): BodyIntent | null {
  if (intent === null || intent.bag === undefined) return intent;
  const { bag: _bag, ...rest } = intent;
  return rest as BodyIntent;
}

/**
 * The deck `cardId` stands in: the live one, or its parked workspace's
 * record. A warm workspace's card has its body while parked, and its facts
 * are its own deck's.
 */
export function ownDeckOf(deck: IDeckManagerStore, cardId: string): DeckState {
  const spaceId = deck.spaceOf(cardId);
  return spaceId === null ? deck.getSnapshot() : (deck.getSpaceDeck(spaceId) ?? deck.getSnapshot());
}

/** The card `state` would make key: its active pane's active card, as `getFirstResponderCardId` reads the live deck. */
function keyCardOf(state: DeckState): string | null {
  return state.panes.find((p) => p.id === state.activePaneId)?.activeCardId ?? null;
}

/**
 * The crossing a body is sent, given the one its pane frame wears and the one
 * the body was last sent.
 *
 * A still crossing before its Last pass holds the interior at the FIRST size.
 * In-document that hold is never painted against a resized frame; a body's
 * page, though, is resized by the host on its own clock, and the set-up hold
 * arriving after that resize paints one frame of the interior at its old size
 * inside the new box (`at0566` sampled it). A body has no use for it — until
 * the plan runs, its box is the First size anyway — so it is sent the crossing
 * once it has settled, and what it was sent before stands until then. A fold,
 * and the crossing's end, go at once.
 */
export function crossingForBody(
  worn: CrossingMirror | null,
  sent: CrossingMirror | null,
): CrossingMirror | null {
  if (worn !== null && worn.still !== null && !worn.settled && worn.fold === null) return sent;
  return worn;
}

/** The `card.context` the shell owes `cardId`'s body now. */
export function cardContextFor(deck: IDeckManagerStore, cardId: string): CardContextValue {
  const spaceId = deck.spaceOf(cardId);
  const spaces = deck.getSpacesSnapshot();
  const layerShown = spaceId === null || spaceId === spaces.activeSpaceId;
  const state = layerShown ? deck.getSnapshot() : ownDeckOf(deck, cardId);
  const railSide = pinnedRailSideOf(state, cardId);
  // The card a warm workspace's first visit will make key is key in its
  // body while it stands parked ([B24] of the bodies migration). Only a
  // workspace nobody has shown: a visited one's key card was deactivated
  // when it parked, and is activated again by its return.
  const parkedKey = !layerShown && spaceId !== null && spaces.warmSpaceIds.includes(spaceId) && keyCardOf(state) === cardId;
  return {
    folded: cardFoldedOf(state, cardId),
    arriving: cardArrivingOf(state, cardId),
    firstResponderCardId: deck.getFirstResponderCardId(),
    layerShown,
    spaceId,
    ...(railSide !== null ? { railSide } : {}),
    ...(parkedKey ? { parkedKey: true as const } : {}),
  };
}

/**
 * The edge `cardId` stands pinned to when it is a rail card: the fact the
 * shell's own pane wears as `data-rail-side`, and that the rail treatment's
 * surface keys on. Null for a content card and for a rail dragged loose.
 */
export function pinnedRailSideOf(state: DeckState, cardId: string): SidebarSide | null {
  const componentId = state.cards.find((c) => c.id === cardId)?.componentId;
  if (componentId === undefined || !isSidebarCard(componentId)) return null;
  return isSidebarPinned(state.imposition, componentId) ? sidebarSide(state.imposition, componentId) : null;
}

function readDeckFacts(deck: IDeckManagerStore): DeckFactsValue {
  return {
    theme: getOnScreenTheme(),
    zoom: pageZoomStore.getFactor(),
    keyboardAccess: keyboardAccessStore.getMode() === "accessibility",
    // What the shell's own key events say is held: a body sees no keys
    // while the shell has the keyboard, and its chord rings read this.
    modifierLatch: heldModifiers(),
    focusRingModality: focusRingModalityStore.getMode(),
    appActive: deck.getSnapshot().hasFocus,
    // The hand switch is the deck's; a body stills its own loops by it.
    motionDemoted: motionBreaker.demoted,
  };
}

/**
 * The arrangement's menu facts, which a body's one-card deck cannot project
 * for itself: the gates a body posts for its card's Go, View and Window items
 * read these ([F19]).
 */
function readDeckMenu(deck: IDeckManagerStore): DeckMenuValue {
  const state = deck.getSnapshot();
  return {
    projection: projectDeckState(state, deck.getSpacesSnapshot()),
    focusTravel: focusTravelDirections(
      state,
      { rail: deck.getRailRunHeight(), column: deck.getColumnRunHeight() },
      deck.getFirstResponderCardId(),
    ),
  };
}

/**
 * Wire the shell to its bodies. Called once from the deck's boot, after the
 * deck exists; a no-op when the host makes no bodies. Returns the uninstall.
 */
export function installBodyShell(connection: TugConnection, deck: IDeckManagerStore): () => void {
  if (!hostCapabilitiesStore.get().bodyViews) return () => {};
  const releases: Array<() => void> = [];
  // The Layout miniature's crossing: the gauges its body draws and the
  // canvas verbs its drags drive (`miniature-bus.ts`).
  releases.push(
    answerMiniature({
      getSnapshot: () => deck.getSnapshot(),
      getHost: getDropZoneHost,
      flashCard: (cardId) => flashCardPane(deck, cardId),
    }),
  );

  // ---- Per-card registrations, held while the card is a body card ----

  const perCard = new Map<string, () => void>();
  const bus = pageBus();
  /** The body cards whose page has said hello. */
  const attachedBodies = (): string[] => [...bus.attachedCards()].filter((id) => bodyCardsStore.has(id));
  const attachedBody = (cardId: string): boolean => bodyCardsStore.has(cardId) && bus.isAttached({ card: cardId });
  /**
   * Whether a command for `cardId` goes to its body: the card is a body card
   * and its page has said hello. Until then the bus would hold the command
   * for a page still coming up, and the key a ⌘W just after ⌘N, or a second
   * workspace switch right behind the first, waits on would land late. The
   * shell answers those itself; its chain reaches the deck through the
   * card's pane.
   */
  const takesCommands = attachedBody;
  /**
   * The body cards whose first frame the host has composited. The card is
   * `painted` to the placer only once the host has said so and the card's
   * `card.painted` has arrived — set behind the facts that frame was drawn
   * with — so a body is never shown under chrome its facts are still on
   * their way to change: a Session card's masthead, which grows the title
   * bar by 52 pt (`at0738-body-arrival`).
   */
  const hostPainted = new Set<string>();
  const notePaint = (cardId: string): void => {
    if (hostPainted.has(cardId) && cardPainted.getFor(cardId)) bodyCardsStore.setState(cardId, "painted");
  };
  /** The member each card's sheet reservation was claimed under. */
  const reservedUnder = new Map<string, string>();
  /** Each body card's deck-scope surface, drawn over the deck. */
  const surfaces = new ShellSurfaceDrawer({
    onActivate: (cardId, path) => surfaceActivate.dispatch({ path }, { card: cardId }),
    onDismiss: (cardId) => surfaceDismissed.dispatch({}, { card: cardId }),
  });
  releases.push(() => surfaces.dispose());

  /** The shell's close guard held for each body card whose guard spoke, with its release. */
  const closeGuards = new Map<string, () => void>();
  /** The modal hold the shell holds for each body card whose run said so, with its release. */
  const modalHolds = new Map<string, () => void>();
  const dropModalHold = (cardId: string): void => {
    modalHolds.get(cardId)?.();
    modalHolds.delete(cardId);
  };
  releases.push(() => {
    for (const release of modalHolds.values()) release();
    modalHolds.clear();
  });
  /** The card each following body card follows, by the shell's focus manager. */
  const followedOf = new Map<string, string>();
  /** The reveal consumer held for a Settings body, with its release. */
  const settingsReveals = new Map<string, () => void>();
  /** The dev-log relay to each devtools body: its release. */
  const devLogRelays = new Map<string, () => void>();
  /** The body cards publishing their inspection, each to the devtools bodies following it. */
  const inspecting = new Map<string, Set<string>>();
  /**
   * The two most recent distinct key cards, latest first. A following card
   * is usually opened by a gesture that makes it the key card before its
   * body is heard, so the card it follows is the key card before that one.
   */
  let recentKeys: string[] = [];
  const noteKey = (key: string): void => {
    if (recentKeys[0] !== key) recentKeys = [key, ...recentKeys.filter((k) => k !== key)].slice(0, 2);
  };

  const forget = (cardId: string): void => {
    perCard.get(cardId)?.();
    perCard.delete(cardId);
    reservedUnder.delete(cardId);
    hostPainted.delete(cardId);
    surfaces.remove(cardId);
    closeGuards.get(cardId)?.();
    closeGuards.delete(cardId);
    dropModalHold(cardId);
    cardIdentityElsewhere.set(cardId, null);
    paneTitleBarItemsStore.set(cardId, null);
    withdrawCloseDecision(cardId);
    followedOf.delete(cardId);
    settingsReveals.get(cardId)?.();
    settingsReveals.delete(cardId);
    devLogRelays.get(cardId)?.();
    devLogRelays.delete(cardId);
    syncInspection();
  };

  /** The registration of the kind `cardId` is, if the deck holds it. */
  const registrationOf = (cardId: string) => {
    const card = ownDeckOf(deck, cardId).cards.find((c) => c.id === cardId);
    return card === undefined ? undefined : getRegistration(card.componentId);
  };
  const kindOf = (cardId: string): string | undefined => registrationOf(cardId)?.componentId;

  /** How many times running each card's body has failed since it was last ready. */
  const failures = new Map<string, number>();

  /**
   * Ask the host again for `cardId`'s body, with what the new page is to do.
   * It carries no bag: the gone body wrote the card's state as it went, so
   * the new one reads it back. A Session card the shell holds a binding for
   * restores it:
   * the gone body's spawn was acknowledged, so re-running a `new` or `fresh`
   * would start a second session. The harness's fake bind is handed again,
   * since no ledger holds it; any other card re-runs what it was handed.
   */
  const askAgain = (cardId: string): void => {
    const handed = withoutBag(bodyIntentOf(cardId));
    let intent: BodyIntent;
    if (isMountBodyKind(kindOf(cardId) ?? "")) {
      intent = { kind: "mount" };
    } else if (handed?.kind === "bind") {
      intent = handed;
    } else if (cardSessionBindingStore.getBinding(cardId) !== undefined) {
      intent = { kind: "restore" };
    } else {
      intent = handed ?? { kind: "restore" };
    }
    askForBodyAgain(cardId, intent);
  };

  /**
   * Keep each body card's inspection published exactly while a devtools
   * body follows it (`card.inspected`), and each devtools body shown the
   * inspection of the card it follows now (`devtools.inspection`), so it
   * never shows the card it left.
   */
  const devtoolsBodies = (): string[] => attachedBodies().filter((id) => kindOf(id) === DEVTOOLS_KIND);
  const syncInspection = (): void => {
    const wanted = new Map<string, Set<string>>();
    for (const devtools of devtoolsBodies()) {
      const followed = followedOf.get(devtools);
      if (followed === undefined || !bodyCardsStore.has(followed)) continue;
      let set = wanted.get(followed);
      if (set === undefined) wanted.set(followed, (set = new Set()));
      set.add(devtools);
    }
    for (const followed of [...inspecting.keys()]) {
      if (wanted.has(followed)) continue;
      inspecting.delete(followed);
      if (bodyCardsStore.has(followed)) cardInspected.setFor(followed, false);
    }
    for (const [followed, set] of wanted) {
      inspecting.set(followed, set);
      cardInspected.setFor(followed, true);
    }
    relayInspections();
  };
  /** Show each devtools body the inspection of the card it follows, or null. */
  const relayInspections = (): void => {
    for (const devtools of devtoolsBodies()) {
      const followed = followedOf.get(devtools);
      const shown = followed !== undefined && inspecting.get(followed)?.has(devtools) === true;
      devtoolsInspection.setFor(devtools, shown ? cardInspection.getFor(followed) : null);
    }
  };
  releases.push(cardInspection.subscribe(relayInspections));

  /** Send `cardId`'s devtools body this page's dev log: all of it now, then each entry as it lands. */
  const relayDevLog = (cardId: string): void => {
    if (devLogRelays.has(cardId)) return;
    let sentThrough = 0;
    const send = (): void => {
      const entries = tugDevLogStore.getSnapshot().entries.filter((e) => e.id > sentThrough);
      if (entries.length === 0) return;
      sentThrough = entries[entries.length - 1].id;
      devtoolsLogEntries.dispatch({ entries: entries.map(relayableLogEntry) }, { card: cardId });
    };
    devLogRelays.set(cardId, tugDevLogStore.subscribe(send));
    send();
  };

  /** Hold the Settings reveal consumer for `cardId`'s body, flushing any parked request into it. */
  const relaySettingsReveal = (cardId: string): void => {
    if (settingsReveals.has(cardId)) return;
    settingsReveals.set(
      cardId,
      registerSettingsRevealConsumer((section) => settingsReveal.dispatch({ section }, { card: cardId })),
    );
  };

  /** Hold a close guard for `cardId` that asks its body's own guard. */
  const holdCloseGuard = (cardId: string): void => {
    if (closeGuards.has(cardId)) return;
    const release = registerCardCloseGuard(cardId, {
      needsDecision: () => cardHolds.getFor(cardId).closeGuardAsks === true,
      // The body's own guard decides, in the card it concerns
      // (`close-decision.ts`): its sheet's person, or a deadline.
      run: () => askCloseDecision(cardId, cardHolds.getFor(cardId).closeGuardAsks === true),
    });
    closeGuards.set(cardId, release);
  };

  /**
   * The crossing `cardId`'s pane stands under, which the body holds its card
   * root through: read off the pane and the placeholder the hold writes its
   * sizes on. Null when none stands.
   */
  const crossingOf = (cardId: string): CrossingMirror | null => {
    const placeholder = document.querySelector<HTMLElement>(
      `[data-body-placeholder][data-card-id="${CSS.escape(cardId)}"]`,
    );
    const frame = placeholder?.closest<HTMLElement>(".tug-pane") ?? null;
    const mirror = placeholder != null && frame !== null ? crossingMirrorOf(frame, placeholder) : null;
    return crossingForBody(mirror, cardCrossing.getFor(cardId));
  };

  const attach = (cardId: string): void => {
    const unregs = [
      registerCardCloseAdvice(cardId, () => ({ waive: bodyFactsStore.waives(cardId) })),
      registerCardFoldGuard(cardId, () => bodyFactsStore.guarded(cardId)),
      deck.observeCardWillBeginDestruction(cardId, () => {
        postToHost("bodyDestroy", { cardId, save: false });
        forget(cardId);
        bus.forgetCard(cardId);
        failures.delete(cardId);
        forgetBodyIntent(cardId);
        bodyCardsStore.drop(cardId);
        bodyChordCaptureStore.clear(cardId);
      }),
    ];
    perCard.set(cardId, () => {
      for (const unreg of unregs) unreg();
    });
  };

  /** Set the shell's stores for `cardId`, which its page is sent at hello: current from the start. */
  const seedCard = (cardId: string): void => {
    cardCrossing.setFor(cardId, crossingOf(cardId));
    cardContext.setFor(cardId, cardContextFor(deck, cardId));
    const followed = followedOf.get(cardId);
    if (followed !== undefined) cardFollowed.setFor(cardId, { cardId: followed });
  };

  const syncCards = (): void => {
    const ids = bodyCardsStore.cardIds();
    for (const cardId of ids) {
      if (perCard.has(cardId)) continue;
      attach(cardId);
      seedCard(cardId);
    }
    for (const cardId of [...perCard.keys()]) {
      if (!bodyCardsStore.has(cardId)) forget(cardId);
    }
  };
  releases.push(bodyCardsStore.subscribe(syncCards));
  syncCards();

  // ---- The kinds the shell hands off itself ----

  // A body kind with no session to start is handed to its body as soon as
  // the deck holds the card — at install for the restored deck, and on every
  // commit for a card added since. `CardHostSwitch` already stands its
  // placeholder for such a card, so it never mounts in this document first.
  //
  // A Session card is handed off by its spawn funnel when the shell has a
  // session to start for it, and here, with a `restore`, once the shell has
  // none: it holds no binding, the startup restore pass has settled, no pass
  // is still asking the ledger about it, and it has no restore in flight. In
  // its body the restore finds no binding and the card shows its picker
  // there. That scan runs a microtask after whatever called it, so a
  // workspace switch's restore (`restoreSpaceSessions`, called right after
  // its commit) has registered what it decided first.
  //
  // A warm workspace's cards ([B24] of the bodies migration) are handed off
  // while it stands parked: its mount kinds, and each Session card the
  // bindings cache, once loaded, names no session for — a card the ledger
  // binds to nothing, which shows its picker wherever it is. A bound one
  // waits for the visit, whose restore spawns its session, so warming a
  // workspace starts none.
  const unboundSessionCard = (cardId: string, componentId: string): boolean =>
    isBodyKind(componentId) &&
    cardSessionBindingStore.getBinding(cardId) === undefined &&
    restorePassGate.getSnapshot() &&
    !restorePassCards.has(cardId) &&
    !sessionRestoreRegistry.has(cardId);
  const knownUnbound = (cardId: string): boolean =>
    spaceBindingsLedgerStore.loaded() && spaceBindingsLedgerStore.get(cardId) === undefined;
  /** The warm workspaces' parked decks. */
  const warmDecks = (): DeckState[] => {
    const spaces = deck.getSpacesSnapshot();
    return spaces.warmSpaceIds.flatMap((id) => {
      const parked = spaces.mountedDecks.get(id);
      return parked === undefined ? [] : [parked];
    });
  };
  const handOffMountKinds = (): void => {
    for (const card of [deck.getSnapshot(), ...warmDecks()].flatMap((d) => d.cards)) {
      if (bodyCardsStore.has(card.id) || !isMountBodyKind(card.componentId)) continue;
      // The card's state goes with it (`handOffToBody`): the shell holds a
      // just-added card's seed in memory, ahead of any write the body could
      // read back.
      handOffToBody(card.id, () => ({ kind: "mount" }));
    }
  };
  const handOffUnboundSessions = (): void => {
    for (const card of deck.getSnapshot().cards) {
      if (bodyCardsStore.has(card.id) || !unboundSessionCard(card.id, card.componentId)) continue;
      handOffToBody(card.id, () => ({ kind: "restore" }));
    }
    for (const card of warmDecks().flatMap((d) => d.cards)) {
      if (bodyCardsStore.has(card.id) || isMountBodyKind(card.componentId)) continue;
      if (!unboundSessionCard(card.id, card.componentId) || !knownUnbound(card.id)) continue;
      handOffToBody(card.id, () => ({ kind: "restore" }));
    }
  };
  let scanQueued = false;
  let installed = true;
  const queueSessionScan = (): void => {
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(() => {
      scanQueued = false;
      if (installed) handOffUnboundSessions();
    });
  };
  releases.push(
    deck.subscribe(() => {
      handOffMountKinds();
      queueSessionScan();
    }),
    restorePassGate.subscribe(queueSessionScan),
    restorePassCards.subscribe(queueSessionScan),
    sessionRestoreRegistry.subscribe(queueSessionScan),
    cardSessionBindingStore.subscribe(queueSessionScan),
    spaceBindingsLedgerStore.subscribe(queueSessionScan),
    // A workspace warmed, or shown for the first time: its cards are handed
    // off as the shown workspace's are.
    deck.subscribeSpaces(() => {
      handOffMountKinds();
      queueSessionScan();
    }),
    () => {
      installed = false;
    },
  );
  handOffMountKinds();
  queueSessionScan();

  // ---- Warming the parked workspaces ----

  // Once the restore pass has settled and every card of the shown
  // workspace that has a body has painted it, every parked workspace is
  // mounted, so its cards are handed off above ([B24] of the bodies
  // migration): a first visit finds them standing, an unbound Session
  // card's picker presented and claimed. Asked again on every change that
  // could make it true — a seed replaces the workspaces — and a no-op once
  // every workspace is mounted.
  const shownBodiesPainted = (): boolean => {
    if (!restorePassGate.getSnapshot()) return false;
    return deck.getSnapshot().cards.every((card) => {
      if (!isBodyKind(card.componentId)) return true;
      const state = bodyCardsStore.stateOf(card.id);
      return state === "painted" || state === "failed";
    });
  };
  let warmQueued = false;
  const queueWarm = (): void => {
    if (warmQueued || deck.warmParkedSpaces === undefined) return;
    warmQueued = true;
    queueMicrotask(() => {
      warmQueued = false;
      if (installed && shownBodiesPainted()) deck.warmParkedSpaces?.();
    });
  };
  releases.push(bodyCardsStore.subscribe(queueWarm), restorePassGate.subscribe(queueWarm), deck.subscribeSpaces(queueWarm));
  queueWarm();

  // The Overview composer's draft outlives its card, which a rail hidden and
  // shown destroys and mints afresh: the shell holds it (`overview.draft`),
  // and the next Overview body seeds its composer from it.
  releases.push(holdOverviewDraftInShell(bus));

  // ---- What the shell tells its bodies ----

  // The stores are set on every change they might follow; each sends only
  // what moved, and a body that says hello is sent their current values.
  const publishDeckFacts = (): void => {
    deckFacts.set(readDeckFacts(deck));
    deckMenu.set(readDeckMenu(deck));
    // The project a card with no session of its own resolves against, which
    // a body's one-card deck cannot find.
    deckFrontmostProject.set({ binding: frontmostProjectBinding() });
  };

  /**
   * Keep every body card's context and crossing current, whether or not its
   * page has said hello yet: what one that does is sent is what stands now.
   */
  const publishCards = (): void => {
    for (const cardId of bodyCardsStore.cardIds()) {
      cardCrossing.setFor(cardId, crossingOf(cardId));
      cardContext.setFor(cardId, cardContextFor(deck, cardId));
    }
  };

  // What a body reads of the deck beyond its own card. Each store sends only
  // what moved, so these are set on every change they might follow.
  const publishBindings = (): void => {
    deckCardBindings.set(projectBindings(deck, (id) => cardSessionBindingStore.getBinding(id)));
  };
  const publishActivities = (): void => {
    deckCardActivities.set(projectActivities(deck, bodyFactsStore.activityOf));
  };
  const publishCardFacts = (): void => {
    arrangementCardFacts.set(
      projectArrangementCardFacts(
        deck,
        (id) => {
          const title = cardTitleStore.get(id);
          const masthead = cardTitleStore.getMasthead(id);
          return title === null && masthead === null ? null : { title, masthead };
        },
        liveCardIdentity,
      ),
    );
  };
  const publishLedgerBindings = (): void => {
    cardsLedgerBindings.set(spaceBindingsLedgerStore.loaded() ? [...spaceBindingsLedgerStore.getSnapshot().values()] : null);
  };
  // The host sends the app's identity with its `show-card`, which only this
  // page hears; the About body reads it from here.
  const publishAppInfo = (): void => appInfo.set(appInfoStore.getSnapshot());
  /** The arrangement, and what moves with the deck's card set. */
  const publishArrangement = (): void => {
    arrangementDeck.set(projectArrangementDeck(deck));
    arrangementSpaces.set(projectArrangementSpaces(deck));
    publishCardFacts();
    publishBindings();
    publishActivities();
  };
  publishArrangement();
  publishLedgerBindings();
  publishAppInfo();

  let focusedBody: string | null | undefined;
  /**
   * Whether the shell holds a stop of its own in the body card's walk —
   * its chrome's — and so the keyboard.
   */
  const shellHoldsStop = (cardId: string): boolean => {
    const manager = getFocusManager();
    return manager !== null && manager.keyCard() === cardId && manager.currentModeMember(manager.keyView());
  };
  /** The body card that should hold the keyboard now, or null for the shell. */
  const keyboardBody = (): string | null =>
    keyboardBodyFor({
      firstResponderCardId: deck.getFirstResponderCardId(),
      isBodyCard: (cardId) => bodyCardsStore.has(cardId),
      shellHoldsStop,
      // A menu or popover the shell raised pushes its trap on the key card's
      // context here, and a shell gesture holds the keyboard for its length:
      // each takes its Escape on this page's `window`.
      shellTakesKeys: shellKeyboardHeld() || getFocusManager()?.currentFocusModeTrapped() === true,
    });
  const postFocus = (force: boolean): void => {
    const target = keyboardBody();
    if (!force && target === focusedBody) return;
    focusedBody = target;
    postToHost("bodyFocus", { cardId: target });
  };
  // A stop the shell takes or lets go of in a body card's walk moves the
  // keyboard without moving the deck's first responder. The engine mounts
  // with the deck, after this, so the watch is taken on the first change.
  let watchingFocus = false;
  const watchFocus = (): void => {
    if (watchingFocus) return;
    const manager = getFocusManager();
    if (manager === null) return;
    watchingFocus = true;
    // A following body card follows the last key card that is not it — the
    // rule `useTrackFollowedCard` runs over this manager in the document.
    const follow = (): void => {
      const key = manager.keyCard();
      if (key === null) return;
      noteKey(key);
      for (const cardId of attachedBodies()) {
        if (key === cardId || registrationOf(cardId)?.bodyFollows !== true) continue;
        if (followedOf.get(cardId) !== key) {
          followedOf.set(cardId, key);
          cardFollowed.setFor(cardId, { cardId: key });
        }
      }
      syncInspection();
    };
    follow();
    releases.push(
      manager.subscribe(() => {
        postFocus(false);
        follow();
      }),
    );
  };

  let lastFirstResponder = deck.getFirstResponderCardId();
  releases.push(
    deck.subscribe(() => {
      watchFocus();
      publishCards();
      publishArrangement();
      publishDeckFacts();
      // A drawn surface hangs off its card, wherever the card now stands.
      surfaces.placeAll();
      const fr = deck.getFirstResponderCardId();
      if (fr !== lastFirstResponder) {
        lastFirstResponder = fr;
        // A press in another body never reaches the shell, but it makes
        // that card the first responder: the keyboard leaving a card closes
        // the surface drawn for it, as the press would have.
        surfaces.dismissAllBut(fr);
        postFocus(true);
      }
    }),
    deck.subscribeSpaces(() => {
      publishCards();
      publishArrangement();
      // The menu facts project the workspaces too, and a workspace made or
      // renamed moves no deck state.
      publishDeckFacts();
    }),
    subscribeOnScreenTheme(publishDeckFacts),
    pageZoomStore.subscribe(publishDeckFacts),
    keyboardAccessStore.subscribe(publishDeckFacts),
    focusRingModalityStore.subscribe(publishDeckFacts),
    subscribeModifierLatch(publishDeckFacts),
    cardSessionBindingStore.subscribe(publishDeckFacts),
    motionBreaker.onChange(publishDeckFacts),
  );
  publishDeckFacts();
  // A workspace's live-session count reads the bindings and the bindings
  // cache, so a change to either is a change to the workspaces too.
  const publishSpaces = (): void => arrangementSpaces.set(projectArrangementSpaces(deck));
  releases.push(
    cardSessionBindingStore.subscribe(() => {
      publishBindings();
      publishSpaces();
    }),
    cardTitleStore.subscribe(publishCardFacts),
    cardIdentityElsewhere.subscribe(publishCardFacts),
    appInfoStore.subscribe(publishAppInfo),
    spaceBindingsLedgerStore.subscribe(() => {
      publishLedgerBindings();
      publishSpaces();
    }),
    // A body publishes on every telemetry tick; the store sends only when
    // some card's phase moved.
    bodyFactsStore.subscribe(publishActivities),
    // The layout selection is the shell's, and the Cards list proposes to it.
    shareLayoutSelection(bus),
    // A body card's binding is the shell's, and its body proposes each change.
    shareCardBinding(bus),
    // A followed card's body may come up after the devtools body did: a
    // session spawned into it, or the card re-adopted.
    bodyCardsStore.subscribe(syncInspection),
  );
  // A crossing's marks are attributes it writes on the pane frame, after the
  // held sizes, so each one re-sends the context of the bodies standing in
  // that frame — in the microtask after the write, ahead of the next frame.
  const crossingWatch = new MutationObserver((records) => {
    const frames = new Set<HTMLElement>();
    for (const record of records) if (record.target instanceof HTMLElement) frames.add(record.target);
    for (const frame of frames) {
      for (const el of frame.querySelectorAll<HTMLElement>("[data-body-placeholder][data-card-id]")) {
        const cardId = el.dataset.cardId;
        if (cardId !== undefined && bodyCardsStore.has(cardId)) cardCrossing.setFor(cardId, crossingOf(cardId));
      }
    }
  });
  crossingWatch.observe(document.body, { subtree: true, attributes: true, attributeFilter: [...CROSSING_FRAME_ATTRS] });
  releases.push(() => crossingWatch.disconnect());
  // An arrangement card hears a commit in the commit's own task, not a
  // painted frame later: the deferral keeps this page's React commit off a
  // motion's first frame, and a body renders in its own page. A row press in
  // the Layout body comes back a frame sooner; the deferred send that follows
  // finds the same context and sends nothing.
  if (deck.subscribeSync !== undefined) releases.push(deck.subscribeSync(publishArrangement, "body-arrangement"));
  // A workspace verb the menu asked the Cards card to answer lands in this
  // page's slot, which a Cards body never reads: it goes to the Cards card of
  // the workspace on screen as soon as the deck holds one, and leaves the
  // slot. The verb also reveals the card, and New stands a fresh workspace
  // whose card has not spoken: the bus holds it until that card's page says
  // hello, behind the stores it reads. A parked workspace's card is never
  // sent it.
  const relaySpaceVerb = (): void => {
    const request = cardsSpaceVerbRequest.getSnapshot();
    if (request === null) return;
    const cardsCard = deck.getSnapshot().cards.find((c) => c.componentId === CARDS_CARD_ID);
    if (cardsCard === undefined || !bodyCardsStore.has(cardsCard.id)) return;
    cardsSpaceVerbRequest.clear();
    cardsSpaceVerb.dispatch({ verb: request.verb, spaceId: request.spaceId }, { card: cardsCard.id });
  };
  releases.push(
    cardsSpaceVerbRequest.subscribe(relaySpaceVerb),
    deck.subscribe(relaySpaceVerb),
    bodyCardsStore.subscribe(relaySpaceVerb),
  );
  relaySpaceVerb();

  // The deck verbs an arrangement card makes, called on the deck: the
  // flow-offset calls are prototype methods, and a detached call loses its
  // `this`.
  releases.push(
    deckActivateCard.handle(({ cardId, reveal }) =>
      reveal === undefined ? deck.activateCard(cardId) : deck.activateCard(cardId, { reveal }),
    ),
    deckSetFlowOffset.handle(({ offset, landing }) =>
      landing === undefined ? deck.setFlowOffset(offset) : deck.setFlowOffset(offset, landing),
    ),
    deckPreviewFlowOffset.handle(({ offset }) => deck.previewFlowOffset(offset)),
    deckActivateSpace.handle(({ spaceId }) => deck.activateSpace(spaceId)),
    deckRenameSpace.handle(({ spaceId, name }) => deck.renameSpace(spaceId, name)),
    deckChooseSpaceTheme.handle(({ spaceId, theme }) => deck.chooseSpaceTheme(spaceId, theme)),
    deckMoveCardToSpace.handle(({ cardId, spaceId }) => void deck.moveCardToSpace(cardId, spaceId)),
    deckReorderSpaces.handle(({ order }) => deck.reorderSpaces(order)),
  );
  // ---- A body's page says hello ----

  // By here its stores have gone to it, ahead of anything held for it. What
  // the shell still keeps by hand for a body not yet there goes now, after
  // them — a page that reloads says hello again and is sent it again.
  releases.push(
    bus.onAttach((cardId) => {
      if (!bodyCardsStore.has(cardId)) return;
      // A following card's history starts with the latest key card that is
      // not itself — the one it was opened over.
      const key = getFocusManager()?.keyCard() ?? null;
      if (key !== null) noteKey(key);
      const prior = recentKeys.find((k) => k !== cardId) ?? null;
      if (prior !== null && registrationOf(cardId)?.bodyFollows === true && !followedOf.has(cardId)) {
        followedOf.set(cardId, prior);
        cardFollowed.setFor(cardId, { cardId: prior });
      }
      const kind = kindOf(cardId);
      if (kind === DEVTOOLS_KIND) relayDevLog(cardId);
      if (kind === SETTINGS_KIND) relaySettingsReveal(cardId);
      syncInspection();
    }),
  );

  // ---- What the bodies tell the shell ----

  /**
   * Call `apply` for each body card whose replica of the card-owned `store`
   * moved since the last call, with the value it had. A replica keeps its
   * object until its value moves, so identity is the change; a card that is
   * not a body card is forgotten, and taken afresh once it is one.
   */
  const watchCardStore = <T>(store: SharedStore<T>, apply: (cardId: string, value: T, prev: T) => void): void => {
    const initial = store.declaration.initial;
    const last = new Map<string, T>();
    const sync = (): void => {
      for (const cardId of new Set([...bodyCardsStore.cardIds(), ...last.keys()])) {
        if (!bodyCardsStore.has(cardId)) {
          last.delete(cardId);
          continue;
        }
        const value = store.getFor(cardId);
        const prev = last.has(cardId) ? (last.get(cardId) as T) : initial;
        if (value === prev) continue;
        if (value === initial) last.delete(cardId);
        else last.set(cardId, value);
        apply(cardId, value, prev);
      }
    };
    releases.push(store.subscribe(sync), bodyCardsStore.subscribe(sync));
  };

  const applyFacts = (cardId: string, facts: CardFactsValue): void => {
    cardIdentityElsewhere.set(cardId, facts.identity);
    paneTitleBarItemsStore.set(cardId, facts.titleBar);
    if (facts.masthead !== null) {
      cardTitleStore.set(cardId, facts.title, facts.masthead);
    } else {
      cardTitleStore.set(cardId, facts.title);
    }
  };

  /**
   * The holds the shell keeps for a body card in its own stores, moved with
   * the card's: the close guard it holds once the card says it has one, the
   * modal hold, and the chord capture. The close advice and the fold guard
   * are read from the replica at gesture time (`bodyFactsStore`).
   */
  const applyHolds = (cardId: string, holds: CardHoldsValue, prev: CardHoldsValue): void => {
    if (holds.closeGuardAsks !== null) holdCloseGuard(cardId);
    const hold = holds.modalHold;
    const was = prev.modalHold;
    if (hold?.reason !== was?.reason || hold?.admitsFold !== was?.admitsFold) {
      dropModalHold(cardId);
      if (hold !== null) {
        modalHolds.set(
          cardId,
          cardModalHoldStore.hold(cardId, {
            reason: hold.reason,
            admitsFold: hold.admitsFold,
            refuse: () => cardRefuseHold.dispatch({}, { card: cardId }),
          }),
        );
      }
    }
    bodyChordCaptureStore.set(cardId, holds.captureArmed);
  };

  const applyReservations = (cardId: string, next: CardReservationsValue, prev: CardReservationsValue): void => {
    if (next.sheetPx !== prev.sheetPx) {
      // A warm workspace's picker reports while parked: its claim goes on
      // the parked record the first visit swaps in ([B24] of the bodies
      // migration), so the arrival is laid out at the floor it needs.
      const spaceId = deck.spaceOf(cardId);
      const parked = spaceId !== null && spaceId !== deck.getSpacesSnapshot().activeSpaceId ? spaceId : null;
      const claim = (memberId: string, height: number | null): void => {
        if (parked !== null && deck.setParkedSheetReservation !== undefined) deck.setParkedSheetReservation(parked, memberId, height);
        else deck.setSheetReservation(memberId, height);
      };
      const standing = sheetReservationMemberIdOf(ownDeckOf(deck, cardId), cardId);
      if (next.sheetPx === null) {
        const claimed = standing ?? reservedUnder.get(cardId);
        reservedUnder.delete(cardId);
        if (claimed !== undefined) claim(claimed, null);
      } else if (standing !== null) {
        reservedUnder.set(cardId, standing);
        claim(standing, next.sheetPx);
      }
    }
    if (next.openingBidPx !== prev.openingBidPx) openingBidForCard(cardId, next.openingBidPx);
  };

  watchCardStore(cardFacts, (cardId, facts) => {
    if (facts !== null) applyFacts(cardId, facts);
  });
  watchCardStore(cardHolds, applyHolds);
  watchCardStore(cardReservations, applyReservations);
  watchCardStore(cardSurface, (cardId, surface: ShellSurface | null) => surfaces.draw(cardId, surface));
  watchCardStore(cardPainted, (cardId, painted) => {
    if (painted) notePaint(cardId);
  });

  /** The body card a verb came from, when it is one this shell holds. */
  const fromBody = (from: { cardId: string | null }): string | null =>
    from.cardId !== null && bodyCardsStore.has(from.cardId) ? from.cardId : null;
  releases.push(
    cardActivate.handle((_payload, from) => {
      const cardId = fromBody(from);
      if (cardId === null) return;
      // A parked body cannot be pressed: an activation from one — a warm
      // workspace's card taking focus in its own page — is not the user's,
      // and would name a key card the deck does not show.
      if (!cardContextFor(deck, cardId).layerShown) return;
      deck.activateCard(cardId);
    }),
    cardClose.handle((_payload, from) => {
      const cardId = fromBody(from);
      if (cardId === null) return;
      const paneId = paneOf(deck.getSnapshot(), cardId);
      if (paneId !== null) deck.removeCard(paneId, cardId);
    }),
    cardAddSibling.handle(({ componentId }, from) => {
      const cardId = fromBody(from);
      if (cardId === null) return;
      const paneId = paneOf(deck.getSnapshot(), cardId);
      if (paneId !== null) deck.addCardToPane(paneId, componentId);
    }),
    // The body's chain did not answer it; this one does, and never sends it
    // back ([P04]: one front door, routed by the entry).
    answerBodyCommands(bus),
    appLogout.handle((_payload, from) => {
      if (fromBody(from) === null) return;
      requestLogout();
    }),
  );

  /** Hand the key card's walk into its body at `edge`, and the keyboard with it. */
  const enterBody = (cardId: string, edge: "first" | "last"): void => {
    const manager = getFocusManager();
    if (manager !== null && manager.keyCard() === cardId) manager.setKeyView(null);
    focusEnter.dispatch({ edge }, { card: cardId });
    postFocus(false);
  };
  // The body's walk ran off an end: the card's chrome stops here come next,
  // from the end the walk arrived at; with none, the walk goes back into the
  // body — unless the body just said it has none either.
  releases.push(
    focusExit.handle(({ direction, empty }, from) => {
      const cardId = from.cardId;
      if (cardId === null || !bodyCardsStore.has(cardId)) return;
      if (deck.getFirstResponderCardId() !== cardId) return;
      const edge = direction === "next" ? "first" : "last";
      const manager = getFocusManager();
      if (manager !== null && manager.keyCard() === cardId && enterKeyViewWalk(manager, edge)) {
        postFocus(false);
        return;
      }
      if (empty !== true) enterBody(cardId, edge);
    }),
  );

  // ---- What the host tells the shell ----

  const bridge = ((window as unknown as { __tugBridge?: Record<string, unknown> }).__tugBridge ??=
    {});
  bridge.onBodyState = (report: BodyStateReport): void => {
    // The host's floor is on screen. It names no card, so it is taken
    // before the card guard below, which would drop it.
    if (report?.state === "floorShown") {
      floorShown(typeof report.sinceRevealMs === "number" ? report.sinceRevealMs : null);
      return;
    }
    const cardId = typeof report?.cardId === "string" ? report.cardId : null;
    if (cardId === null || !bodyCardsStore.has(cardId)) return;
    switch (report.state) {
      case "ready":
        bodyCardsStore.setState(cardId, "ready");
        failures.delete(cardId);
        // The body exists now; if its card holds the keyboard, it takes it.
        if (deck.getFirstResponderCardId() === cardId) postFocus(true);
        return;
      case "painted":
        // Its first frame of content is composited; the placer may show it
        // once the bus has said so too, behind the facts the frame drew.
        hostPainted.add(cardId);
        notePaint(cardId);
        return;
      case "shown":
        // The host's container is placed, opaque and drawn: the lid lifts.
        bodyShown(cardId);
        return;
      case "landed":
        // The host ran the body's planned beats to their end.
        if (typeof report.planId === "number") {
          bodyBeatsLanded(cardId, report.planId, typeof report.lateMs === "number" ? report.lateMs : null);
        }
        return;
      case "beatsCancelled":
        // A placement or a newer plan took the body before it landed.
        if (typeof report.planId === "number") bodyBeatsCancelled(cardId, report.planId);
        return;
      case "terminated":
        // Reloading under the same card: the card is detached until the new
        // page says hello, which is answered with its stores again, since
        // the page that held them is gone. What only that page held — its
        // holds, its surface, its paint, its restore, its inspection —
        // clears with the detach, and the shell's holds go with them. The
        // masthead the old page showed stands: the new page reports
        // none until its restore binds, and that is a page starting, not a
        // card letting its session go — the binding the shell keeps stands.
        bodyCardsStore.setState(cardId, "creating");
        // The page that would have answered a close decision is gone, and
        // the detach cancels it; a question it showed is shown again.
        bus.detach(cardId);
        hostPainted.delete(cardId);
        return;
      case "failed": {
        // The host has destroyed the body. The card stays a body card —
        // every card is one, so the shell has no other place for it — and
        // what the gone page told the shell goes with the page, as at a
        // termination, its facts too. Marked failed, so an arrival waiting
        // on the body reveals now rather than at its bound: the card stands
        // lidded. Forgetting the card drops the shell's own stores for it
        // as well, which the next page is sent at hello, so they are set
        // again at once.
        bus.detach(cardId);
        bus.forgetCard(cardId);
        seedCard(cardId);
        hostPainted.delete(cardId);
        bodyCardsStore.setState(cardId, "failed");
        const attempts = (failures.get(cardId) ?? 0) + 1;
        failures.set(cardId, attempts);
        if (attempts > BODY_RETRIES) {
          // Failed again: the card shows it, with a Reload that asks once more.
          tugDevLogStore.error("body", "a body failed again; its card shows a Reload", {
            cardId,
            cause: report.cause,
          });
          return;
        }
        tugDevLogStore.warn("body", "a body failed; asking for it again", {
          cardId,
          cause: report.cause,
        });
        askAgain(cardId);
        return;
      }
    }
  };
  releases.push(() => {
    delete bridge.onBodyState;
  });

  // A failed card's Reload, from its placard.
  setBodyReloader(askAgain);
  releases.push(() => {
    setBodyReloader(null);
  });

  // ---- Menu commands bound for the key card ----

  /** The shell's chain against the deck's first-responder card, or null with no chain. */
  const chainNow = () => {
    const firstResponderCardId = deck.getFirstResponderCardId();
    const manager = getResponderChainManager();
    if (manager === null) return null;
    const paneId =
      firstResponderCardId === null ? null : paneOf(deck.getSnapshot(), firstResponderCardId);
    return {
      responder: manager.getFirstResponder() ?? null,
      paneId,
      cardId: firstResponderCardId,
      isWithin: (id: string, ancestorId: string) => manager.nodeIsWithin(id, ancestorId),
    };
  };
  /** Whether a shell surface holds the chain ahead of the deck's first-responder card. */
  const shellAheadNow = (): boolean => {
    const chain = chainNow();
    return chain !== null && shellSurfaceAhead(chain);
  };

  // ---- The keyboard is the body's while its card is the first responder ----
  //
  // A page that focuses a DOM element asks the window to make its web view
  // the first responder, so the shell parking its key sink would take the
  // keyboard from the body every time. While a body card is the deck's
  // first responder and no shell surface holds the chain ahead of it, the
  // shell parks nothing and, asked to, hands the keyboard to the body again.
  releases.push(
    setKeyboardYield(
      () => {
        return keyboardBody() !== null && !shellAheadNow();
      },
      () => postFocus(true),
      keyboardBody,
    ),
    // A shell gesture's hold takes the keyboard from the key body at once,
    // ahead of the Escape it listens for, and gives it back when it ends.
    subscribeShellKeyboardHold(() => postFocus(false)),
  );
  // While the keyboard is a body's, the shell wears that body's
  // keyboard-focus paint (`card.kbfPaint`, which the shell's engine reads
  // for the body the yield names): the Overview's seeded caret stands the
  // mode's paint down in its page, and the shell's root must not paint it
  // beside. The body's answer moves with no change in the shell's own focus
  // state, so the engine is asked to repaint when the word it would read
  // moves.
  let yieldedPaint: boolean | null = null;
  releases.push(
    bodyFactsStore.subscribe(() => {
      const body = keyboardBody();
      const now = body === null ? null : bodyFactsStore.kbfPaintOf(body);
      if (now === yieldedPaint) return;
      yieldedPaint = now;
      getFocusManager()?.settleKbfEngagement();
    }),
  );
  // A pointer gesture in the shell makes the shell's web view the first
  // responder whether or not the deck's first responder changed — a click
  // on the key card's own title bar changes nothing in the deck, so the
  // subscription above posts nothing. After the gesture lands, the keyboard
  // goes back to the body if the shell has yielded it.
  const onShellPointerUp = (): void => {
    window.setTimeout(() => {
      if (keyboardBody() !== null && !shellAheadNow()) postFocus(true);
    }, 0);
  };
  window.addEventListener("pointerup", onShellPointerUp, true);
  releases.push(() => window.removeEventListener("pointerup", onShellPointerUp, true));

  // The key card's commands, and the shell's walk off the end of its own
  // stops: the route (`bus/command-route.ts`) hands each to the key card's
  // body while that card is a body card whose page has said hello and no
  // shell surface holds the chain ahead of it. A command sent there takes the
  // keyboard with it: the shell may hold it (a popover it raised took the
  // click) while the deck's first responder is the body's card, and a command
  // that focuses something in the body is no use if keys still land here.
  //
  // A step of the shell's walk while a body card is key — a Tab the shell
  // holds — is the body's to take while the shell holds none of the card's
  // stops: it steps from the body's own key view. Run off the end of the
  // shell's chrome stops, it goes into the body.
  releases.push(
    installKeyCardRoute({
      target: (entry) => {
        const chain = chainNow();
        return bodyCommandRoute({
          id: entry.id,
          routing: entry.routing,
          owner: entry.owner,
          firstResponderCardId: deck.getFirstResponderCardId(),
          isBodyCard: takesCommands,
          shellResponderAhead: chain !== null && shellSurfaceAhead(chain),
          shellResponderAbove: chain !== null && shellResponderAboveCard(chain),
          shellHoldsStop,
        });
      },
      sent: () => postFocus(true),
      walkEdge: (direction) => {
        const fr = deck.getFirstResponderCardId();
        if (fr === null || !takesCommands(fr)) return false;
        if (shellHoldsStop(fr)) {
          enterBody(fr, direction === 1 ? "first" : "last");
          return true;
        }
        const id = direction === 1 ? TUG_ACTIONS.NEXT_KEYBOARD_FOCUS : TUG_ACTIONS.PREVIOUS_KEYBOARD_FOCUS;
        commandForCard.dispatch({ id }, { card: fr });
        postFocus(false);
        return true;
      },
    }),
  );

  return () => {
    for (const release of releases.splice(0)) release();
    for (const cardId of [...perCard.keys()]) forget(cardId);
  };
}
