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
 *   before anything held for it. Each card is also sent its pane as its
 *   chrome draws it (`pane.chrome`, `pane-chrome-projection.ts`), the same
 *   value to every card of a pane, and the chrome's gestures come back as the
 *   `pane.*` actions, answered here by `pane-verbs.ts` for a card on the
 *   shown layer and only for a card of the sender's own pane. Every card's
 *   binding and reported phase go to every body the same way
 *   (`deck.cardBindings`, `deck.cardActivities`).
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
 *   arrives as `card.surface` and is relayed to the overlay with the card's
 *   rest geometry, which draws it over every card where the in-document card
 *   would have drawn it (`surface-relay.ts`); a press in it or its dismissal
 *   goes back as `surface.activate` / `surface.dismissed`.
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

import type { CardSurface } from "../bus/declarations/card";
import { overlaySurfaceActivate, overlaySurfaceDismissed } from "../bus/declarations/overlay";
import type { TugConnection } from "../connection";
import type { IDeckManagerStore } from "../deck-manager-store";
import type { DeckState } from "../layout-tree";
import { getResponderChainManager } from "../action-registry";
import { answerBodyCommands } from "../command-dispatch";
import { enterKeyViewWalk, getFocusManager } from "./active-focus-manager";
import { TUG_ACTIONS } from "./action-vocabulary";
import { OVERLAY_CARD_ID } from "./overlay-card";
import { setKeyboardYield } from "./keyboard-yield";
import { getOnScreenTheme, subscribeOnScreenTheme } from "../contexts/theme-provider";
import { cardArrivingOf, cardFoldedOf } from "../deck-store-selectors";
import { keyboardAccessStore } from "../keyboard-access-store";
import { focusRingModalityStore } from "../focus-ring-modality-store";
import { heldModifiers, subscribeModifierLatch } from "./modifier-latch";
import { projectDeckState } from "./host-menu-state";
import { focusTravelDirections } from "./directional-focus";
import { bodyCardsStore, pageless } from "./body-cards-store";
import { bodyCommandRoute, keyboardBodyFor, shellResponderAboveCard, shellSurfaceAhead } from "./body-command-route";
import { shellKeyboardHeld, subscribeShellKeyboardHold } from "./shell-keyboard-hold";
import { bodyFactsStore } from "./body-facts-store";
import { bodilessFactsStore } from "./bodiless-facts-store";
import { scheduleAfterPaint } from "./after-paint";
import { bodyStandInStore } from "./body-stand-in-store";
import {
  cardCrossingReleased,
  cardIsSolving,
  cardPlanCancelled,
  cardPlanLanded,
  cardPlacementDiag,
  shownFactsOf,
  wantsBodyShown,
} from "./card-placement";
import { mergeBandOf } from "./drop-zones";
import { CANVAS_BACKGROUND_ATTRIBUTE, paneCanvasOf, SHOWN_PANE_FRAMES } from "./pane-frame-selectors";
import { getTugTiming } from "./scale-timing";
import { registerCardCloseAdvice } from "./card-close-advice";
import { registerCardFoldGuard } from "./card-fold";
import { cardSessionBindingStore, ledgerSegmentForCard, shareCardBinding } from "./card-session-binding-store";
import { getSessionLedgerStore, subscribeSessionLedger } from "./session-ledger-store";
import { shareArcPresses } from "./arc-press-store";
import { cardTitleStore } from "./card-title-store";
import { CARDS_CARD_ID } from "./cards-card-id";
import { cardsSpaceVerbRequest } from "./cards-space-verb-request";
import { requestLogout } from "./logout-store";
import { overlaySurfaceBook } from "./overlay-surfaces";
import { createSurfaceRelay, overlayRectOf } from "./surface-relay";
import { indicate } from "./drag-indication";
import { askCloseDecision, withdrawCloseDecision } from "./close-decision";
import { closeRefusalStore } from "./close-refusal-store";
import { createKeptGuardWords } from "./kept-guard-word";
import { getTugbankClient } from "./tugbank-singleton";
import { putGuardWord, readGuardWords } from "../settings-api";
import { pageBus, type PageBus } from "../bus/page-bus";
import { installKeyCardRoute } from "../bus/command-route";
import {
  appLogout,
  cardActivate,
  cardAddSibling,
  cardClose,
  cardFlash,
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
  cardGuardAsks,
  cardHolds,
  cardInspected,
  cardInspection,
  cardPainted,
  cardReservations,
  cardSurface,
  devtoolsInspection,
  NO_CARD_GEOMETRY,
  type CardContextValue,
  type CardGeometryCounts,
  type CardFactsValue,
  type CardHoldsValue,
  type CardReservationsValue,
} from "../bus/declarations/card";
import {
  paneArrangePlace,
  paneChrome,
  paneCloseCard,
  paneClosePane,
  paneFillHeight,
  paneMoveToSpace,
  paneReorderTabs,
  paneTabDrag,
  paneRevealCard,
  paneRevealForQuestion,
  paneRevealStackEntry,
  paneSelectTab,
  paneSetWidth,
  paneToggleBullseye,
  type PaneChromeValue,
} from "../bus/declarations/pane";
import type { SharedStore } from "../bus/shared-store";
import { paneChromeFor } from "./pane-chrome-projection";
import {
  arrangePlace,
  closePane,
  closeTab,
  fillPaneHeight,
  moveActiveCardToSpace,
  paneVerbAddress,
  placeSlotOf,
  revealStackEntry,
  selectTab,
  setPaneWidth,
  stackEntryCardOf,
  togglePaneBullseye,
} from "./pane-verbs";
import {
  deckCards,
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
  intentToAskAgain,
  isBodyKind,
  isMountBodyKind,
  releaseDeferredBody,
  setBodyDeferral,
  setBodyReloader,
} from "./body-handoff";
import { onHostMessage, postToHost } from "../host/channel";
import {
  bodyDestroyToHost,
  bodyFocusToHost,
  bodyStateToPage,
} from "../host/declarations/lifecycle";
import { restorePassCards, restorePassGate, sessionRestoreRegistry } from "./session-restore";
import { spaceBindingsLedgerStore } from "./space-bindings-ledger-store";
import { openingBidForCard } from "./opening-bid";
import { deckRootElement, layoutPxOf, pageZoomStore } from "./page-zoom-store";
import { bodyChordCaptureStore } from "./body-chord-capture-store";
import { sheetReservationMemberIdOf } from "./sheet-reservation";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";
import { getRegistration, isSidebarCard } from "../card-registry";
import { cardIdentity, cardIdentityElsewhere, liveCardIdentity } from "./card-identity";
import { paneTitleBarItemsStore } from "./pane-title-bar-items-store";
import { isSidebarPinned, readSettleMs, sidebarSide, type SidebarSide } from "./layout-imposer";
import {
  projectArrangementDeck,
  projectArrangementSpaces,
  projectDeckCards,
  sessionStateOf,
} from "./body-arrangement";
import {
  appInfo,
  arrangementDeck,
  arrangementSpaces,
  cardFollowed,
  cardsLedgerBindings,
  cardsSpaceVerb,
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
} from "../bus/declarations/arrangement";
import { answerMiniature } from "./miniature-bus";
import { getDropZoneHost } from "./drop-zone-host-registry";
import { flashCardPane, setPaneFlashRelay } from "./flash-pane-border";
import { shareLayoutSelection } from "./cards-selection-store";
import { registerCardCloseGuard } from "./card-close-guard";
import { cardModalHoldStore, isCardHeld, refuseCardModalHold } from "./card-modal-hold-store";
import { closeGuardWalk } from "./close-guard-walk";
import { appInfoStore } from "./app-info-store";
import { registerSettingsRevealConsumer } from "./settings-reveal";
import { frontmostProjectBinding, workspaceProjectDirs } from "./frontmost-project";
import { canonicalDirStore } from "./canonical-dir-store";
import { motionBreaker } from "./motion-guard/breaker";
import { holdOverviewDraftInShell } from "./overview-composer-draft";
import { CROSSING_FRAME_ATTRS, crossingMirrorOf } from "./fold-crossing";
import type { TugDevLogEntry } from "./tug-dev-log-store/types";
import { FeedId } from "../protocol";

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
 * record. A visited workspace's card keeps its body while parked, and its
 * facts are its own deck's.
 */
export function ownDeckOf(deck: IDeckManagerStore, cardId: string): DeckState {
  const spaceId = deck.spaceOf(cardId);
  return spaceId === null ? deck.getSnapshot() : (deck.getSpaceDeck(spaceId) ?? deck.getSnapshot());
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

/**
 * The `card.context` the shell owes `cardId`'s body now, carrying `geometry`:
 * the moves and resizes the shell has counted for the card since it attached.
 */
export function cardContextFor(
  deck: IDeckManagerStore,
  cardId: string,
  geometry: CardGeometryCounts = NO_CARD_GEOMETRY,
): CardContextValue {
  const spaceId = deck.spaceOf(cardId);
  const spaces = deck.getSpacesSnapshot();
  const layerShown = spaceId === null || spaceId === spaces.activeSpaceId;
  const state = layerShown ? deck.getSnapshot() : ownDeckOf(deck, cardId);
  const railSide = pinnedRailSideOf(state, cardId);
  return {
    folded: cardFoldedOf(state, cardId),
    arriving: cardArrivingOf(state, cardId),
    firstResponderCardId: deck.getFirstResponderCardId(),
    layerShown,
    spaceId,
    ...(railSide !== null ? { railSide } : {}),
    geometry,
  };
}

/** The shell's count of each body card's committed moves and resizes, which its `card.context` carries. */
export interface CardGeometryCountsStore {
  /** `cardId`'s counts: none before its first move or resize. */
  of(cardId: string): CardGeometryCounts;
  /** Count a move or resize the deck committed for `cardId`, and publish the card's context. */
  count(cardId: string, counted: keyof CardGeometryCounts): void;
  /** Drop `cardId`'s counts: its card is going. */
  forget(cardId: string): void;
}

/** Hold the counts, calling `publish` with the card whose count rose. */
export function createCardGeometryCounts(publish: (cardId: string) => void): CardGeometryCountsStore {
  const counts = new Map<string, CardGeometryCounts>();
  return {
    of: (cardId) => counts.get(cardId) ?? NO_CARD_GEOMETRY,
    count: (cardId, counted) => {
      const prev = counts.get(cardId) ?? NO_CARD_GEOMETRY;
      counts.set(cardId, { ...prev, [counted]: prev[counted] + 1 });
      publish(cardId);
    },
    forget: (cardId) => {
      counts.delete(cardId);
    },
  };
}

/** The `pane.chrome` the shell owes `cardId`'s body now: its pane on the deck it stands in. */
export function paneChromeOf(deck: IDeckManagerStore, cardId: string): PaneChromeValue | null {
  const spaceId = deck.spaceOf(cardId);
  const spaces = deck.getSpacesSnapshot();
  const layerShown = spaceId === null || spaceId === spaces.activeSpaceId;
  const state = layerShown ? deck.getSnapshot() : ownDeckOf(deck, cardId);
  return paneChromeFor(state, cardId, {
    titleOf: (id) => cardTitleStore.get(id),
    waives: (id) => bodyFactsStore.waives(id),
    spaces: { list: spaces.spaces, ownSpaceId: spaceId ?? spaces.activeSpaceId },
  });
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

/** The shell's gate on showing a body: {@link createBodyPaintGate}. */
export interface BodyPaintGate {
  /** The host composited the card's first frame. */
  hostPainted(cardId: string): void;
  /** The card's page is gone: its host half no longer stands. */
  forget(cardId: string): void;
  dispose(): void;
}

/**
 * When a body card may be shown: once the host has composited its first
 * frame, `card.painted` has arrived, and `card.facts` has arrived. The
 * facts are waited on here rather than trusted to arrive first, so the
 * order snapshots reach the shell in never decides when a body is shown
 * under chrome its facts are still on their way to change — a Session
 * card's masthead grows the title bar by 52 pt (`at0738-body-arrival`).
 * Reads the stores on `bus`, the shell's page bus.
 */
export function createBodyPaintGate(bus: PageBus, markPainted: (cardId: string) => void): BodyPaintGate {
  /** Cards the host has painted, still waiting on the bus's half. */
  const waiting = new Set<string>();
  const painted = cardPainted.on(bus);
  const facts = cardFacts.on(bus);
  const check = (cardId: string): void => {
    if (!waiting.has(cardId) || !painted.getFor(cardId) || !facts.arrived(cardId)) return;
    waiting.delete(cardId);
    markPainted(cardId);
  };
  const checkAll = (): void => {
    for (const cardId of [...waiting]) check(cardId);
  };
  const releases = [painted.subscribe(checkAll), facts.subscribe(checkAll)];
  return {
    hostPainted(cardId) {
      waiting.add(cardId);
      check(cardId);
    },
    forget(cardId) {
      waiting.delete(cardId);
    },
    dispose() {
      for (const release of releases) release();
      waiting.clear();
    },
  };
}

/**
 * The pane whose title band holds `point` (viewport px), other than
 * `sourcePaneId`, and that band: where a tab dragged past its own bar would
 * merge. Read off the shown frames, so a stand-in's band is as much a target
 * as a pane the shell draws.
 */
function tabMergeTargetAt(
  deck: IDeckManagerStore,
  point: { x: number; y: number },
  sourcePaneId: string,
): { paneId: string; band: { x: number; y: number; width: number; height: number } } | null {
  for (const frame of document.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES)) {
    const paneId = frame.dataset.paneId;
    if (paneId === undefined || paneId === sourcePaneId) continue;
    const r = frame.getBoundingClientRect();
    const tabbed = (deck.getSnapshot().panes.find((p) => p.id === paneId)?.cardIds.length ?? 0) > 1;
    const band = mergeBandOf({ x: r.x, y: r.y, width: r.width, height: r.height }, frame.dataset.role === "sidebar" ? "sidebar" : "content", tabbed);
    if (point.x >= band.x && point.x < band.x + band.width && point.y >= band.y && point.y < band.y + band.height) {
      return { paneId, band };
    }
  }
  return null;
}

/**
 * Wire the shell to its bodies. Called once from the deck's boot, after the
 * deck exists; a no-op when the host makes no bodies. Returns the uninstall.
 */
export function installBodyShell(connection: TugConnection, deck: IDeckManagerStore): () => void {
  if (!hostCapabilitiesStore.get().bodyViews) return () => {};
  const releases: Array<() => void> = [];
  // A card handed off while it is not shown — an inactive tab, or a card out
  // of the shown workspace — gets no page until it is (`body-handoff.ts`);
  // `reviveWanted` asks for it then. An arriving card is not one: its
  // arrival waits on its body's paint. Set before any hand-off below.
  setBodyDeferral((cardId) => {
    const facts = shownFactsOf(deck, cardId);
    return facts !== null && (!facts.active || !facts.layerShown);
  });
  releases.push(() => setBodyDeferral(null));
  // The Layout miniature's crossing: the gauges its body draws and the
  // canvas verbs its drags drive (`miniature-bus.ts`).
  releases.push(
    answerMiniature({
      getSnapshot: () => deck.getSnapshot(),
      getHost: getDropZoneHost,
      flashCard: (cardId) => flashCardPane(deck, cardId),
    }),
  );
  // A rung pane's ring is drawn by its card's page, which stands opaque over
  // the shell's stand-in ([D216]). Every card of the pane is told, so a tab
  // switch mid-ring shows it lit.
  const rungPane = (paneId: string) => deck.getSnapshot().panes.find((p) => p.id === paneId);
  setPaneFlashRelay({
    draws: (paneId) => {
      const active = rungPane(paneId)?.activeCardId;
      return active !== undefined && bodyCardsStore.has(active) && bodyCardsStore.stateOf(active) !== "failed";
    },
    tell: (paneId, lit) => {
      for (const cardId of rungPane(paneId)?.cardIds ?? []) {
        if (bodyCardsStore.has(cardId)) cardFlash.dispatch({ lit }, { card: cardId });
      }
    },
  });
  releases.push(() => setPaneFlashRelay(null));

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
   * The card is `painted` to the placer only once the host has composited
   * its first frame and both `card.painted` and `card.facts` have arrived
   * ({@link createBodyPaintGate}).
   */
  const paintGate = createBodyPaintGate(bus, (cardId) => bodyCardsStore.setState(cardId, "painted"));
  releases.push(() => paintGate.dispose());
  // A close decision the body did not answer flashes its pane; the banner is the placeholder's.
  releases.push(closeRefusalStore.onRefuse((cardId) => flashCardPane(deck, cardId)));
  /** The member each card's sheet reservation was claimed under. */
  const reservedUnder = new Map<string, string>();
  /** Each body card's deck-scope surface, relayed to the overlay at its card's rest rect. */
  const surfaces = createSurfaceRelay({
    book: overlaySurfaceBook,
    measure: (cardId) => {
      const placeholder = document.querySelector<HTMLElement>(
        `[data-body-placeholder][data-card-id="${CSS.escape(cardId)}"]`,
      );
      if (placeholder === null) return null;
      const pane = placeholder.closest<HTMLElement>(".tug-pane");
      const canvas = pane === null ? null : paneCanvasOf(pane);
      return {
        body: overlayRectOf(placeholder.getBoundingClientRect()),
        pane: pane === null ? null : overlayRectOf(pane.getBoundingClientRect()),
        bound: canvas === null ? null : overlayRectOf(canvas.getBoundingClientRect()),
      };
    },
    dismiss: (cardId) => surfaceDismissed.dispatch({}, { card: cardId }),
  });
  releases.push(() => surfaces.dispose());
  releases.push(
    overlaySurfaceActivate.handle(({ cardId, path }, from) => {
      if (from.cardId === OVERLAY_CARD_ID) surfaceActivate.dispatch({ path }, { card: cardId });
    }),
    overlaySurfaceDismissed.handle(({ cardId }, from) => {
      if (from.cardId === OVERLAY_CARD_ID) surfaces.dismissed(cardId);
    }),
  );

  /** The shell's close guard held for each body card whose guard spoke, with its release. */
  const closeGuards = new Map<string, () => void>();
  /**
   * The word each evicted page left that its card's close asks, kept until
   * the card's next page answers for itself (`kept-guard-word.ts`), and read
   * back from its durable copy at load, so a shell reload keeps it too. The
   * durable copy is held back in test mode, as the deck holds its own.
   */
  const keptWords = createKeptGuardWords(
    {
      get: (cardId) => cardGuardAsks.getFor(cardId),
      set: (cardId, asks) => cardGuardAsks.setFor(cardId, asks),
      persist: (cardId, asks) => {
        if (window.__tugTestMode === true && window.__tugPersistInTestMode !== true) return;
        void putGuardWord(cardId, asks);
      },
    },
    (() => {
      const client = getTugbankClient();
      return client === null ? [] : readGuardWords(client);
    })(),
  );
  /** Whether `cardId`'s close guard would ask: its page's word, or the word its evicted page left. */
  const guardAsks = (cardId: string): boolean =>
    cardHolds.getFor(cardId).closeGuardAsks === true || keptWords.asks(cardId);
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
  /** The moves and resizes the deck has committed for each body card since it attached. */
  const geometry = createCardGeometryCounts((cardId) => cardContext.setFor(cardId, contextOf(cardId)));
  /** The `card.context` `cardId`'s body is owed now, with its counts. */
  const contextOf = (cardId: string): CardContextValue => cardContextFor(deck, cardId, geometry.of(cardId));
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
    paintGate.forget(cardId);
    closeRefusalStore.clear(cardId);
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
   * It carries no bag, and the intent is {@link intentToAskAgain}'s.
   */
  const askAgain = (cardId: string): void => {
    askForBodyAgain(
      cardId,
      intentToAskAgain(
        withoutBag(bodyIntentOf(cardId)),
        isMountBodyKind(kindOf(cardId) ?? ""),
        cardSessionBindingStore.getBinding(cardId) !== undefined,
      ),
    );
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
      needsDecision: () => guardAsks(cardId),
      // The body's own guard decides, in the card it concerns
      // (`close-decision.ts`): its sheet's person, or a deadline. An evicted
      // card's close is asked of the page that brings it back, which the
      // pane's activating it before the ask has asked for.
      run: () => askCloseDecision(cardId, guardAsks(cardId)),
    });
    closeGuards.set(cardId, release);
  };

  /**
   * The crossing `cardId`'s pane stands under, which the body holds its card
   * root through: read off the pane and the placeholder the hold writes its
   * sizes on. Null when none stands — and for a card a solving plan carries,
   * whose page lays itself out at its landing size before the motion: there
   * is no moving edge inside it to hold still, and a hold released at the
   * land would relayout the page there. The card stays solving past the host's
   * `landed` until the pane's mark is seen gone, which is read here.
   */
  const crossingOf = (cardId: string): CrossingMirror | null => {
    const placeholder = document.querySelector<HTMLElement>(
      `[data-body-placeholder][data-card-id="${CSS.escape(cardId)}"]`,
    );
    const frame = placeholder?.closest<HTMLElement>(".tug-pane") ?? null;
    const mirror = placeholder != null && frame !== null ? crossingMirrorOf(frame, placeholder) : null;
    if (mirror === null) cardCrossingReleased(cardId);
    if (cardIsSolving(cardId)) return null;
    return crossingForBody(mirror, cardCrossing.getFor(cardId));
  };

  const attach = (cardId: string): void => {
    const unregs = [
      registerCardCloseAdvice(cardId, () => ({ waive: bodyFactsStore.waives(cardId) })),
      registerCardFoldGuard(cardId, () => bodyFactsStore.guarded(cardId)),
      // A move or resize the deck commits is the card's to hear in its page,
      // where its delegates are: its context counts them, and the page's deck
      // fires the events as the counts rise.
      deck.observeCardDidMove(cardId, () => geometry.count(cardId, "moves")),
      deck.observeCardDidResize(cardId, () => geometry.count(cardId, "resizes")),
      deck.observeCardWillBeginDestruction(cardId, () => {
        postToHost(bodyDestroyToHost, { cardId, save: false });
        keptWords.closed(cardId);
        forget(cardId);
        geometry.forget(cardId);
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
    // A card whose evicted page's word stands — read back after a shell
    // reload — has a close that asks before any page of it says so.
    if (keptWords.asks(cardId)) holdCloseGuard(cardId);
  };

  /** Set the shell's stores for `cardId`, which its page is sent at hello: current from the start. */
  const seedCard = (cardId: string): void => {
    cardCrossing.setFor(cardId, crossingOf(cardId));
    cardContext.setFor(cardId, contextOf(cardId));
    paneChrome.setFor(cardId, paneChromeOf(deck, cardId));
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
  // Only the shown workspace's cards are handed off. A parked workspace
  // nobody has shown has no bodies: its cards arrive as any card arrives on
  // its first visit, and a visited workspace's bodies go dormant once it is
  // parked again.
  //
  // A Session card whose body outlived a shell reload is handed off here
  // too, bound or not: its page has said hello to this shell before this
  // shell asked for it, and it tells the binding it holds, which would
  // otherwise leave the card to a restore pass that may never run for it.
  // The host answers it with the page it kept, never a new one, so the
  // `restore` it is handed is not replayed. The same settled-pass guards
  // hold, so a pass that is still deciding for the card is never raced.
  const keptBody = (cardId: string): boolean => bus.attachedCards().has(cardId);
  const sessionCardToHandOff = (cardId: string, componentId: string): boolean =>
    isBodyKind(componentId) &&
    (cardSessionBindingStore.getBinding(cardId) === undefined || keptBody(cardId)) &&
    restorePassGate.getSnapshot() &&
    !restorePassCards.has(cardId) &&
    !sessionRestoreRegistry.has(cardId);
  const handOffMountKinds = (): void => {
    for (const card of deck.getSnapshot().cards) {
      if (bodyCardsStore.has(card.id) || !isMountBodyKind(card.componentId)) continue;
      // The card's state goes with it (`handOffToBody`): the shell holds a
      // just-added card's seed in memory, ahead of any write the body could
      // read back.
      handOffToBody(card.id, () => ({ kind: "mount" }));
    }
  };
  const handOffUnboundSessions = (): void => {
    for (const card of deck.getSnapshot().cards) {
      if (bodyCardsStore.has(card.id) || !sessionCardToHandOff(card.id, card.componentId)) continue;
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
    // A workspace shown for the first time: its cards are handed off as the
    // shown workspace's are.
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
    // The project a card with no session of its own resolves against, and
    // the workspace's project set a Choose Session sheet opens on, which a
    // body's one-card deck cannot find.
    deckFrontmostProject.set({
      binding: frontmostProjectBinding(),
      projectDirs: [...workspaceProjectDirs()],
    });
  };

  /**
   * Keep every body card's context and crossing current, whether or not its
   * page has said hello yet: what one that does is sent is what stands now.
   */
  const publishCards = (): void => {
    for (const cardId of bodyCardsStore.cardIds()) {
      cardCrossing.setFor(cardId, crossingOf(cardId));
      cardContext.setFor(cardId, contextOf(cardId));
      paneChrome.setFor(cardId, paneChromeOf(deck, cardId));
    }
  };
  /** Each body card's chrome alone: its tabs' titles move with no deck change. */
  const publishPaneChrome = (): void => {
    for (const cardId of bodyCardsStore.cardIds()) paneChrome.setFor(cardId, paneChromeOf(deck, cardId));
  };

  /** The supervisor's last SESSION_STATE for each session, by its address ({@link sessionStateOf}). */
  const childStates = new Map<string, string>();
  // What a body reads of every card beyond its own, as one record per card.
  // The store sends only what moved, so it is set on every change it might
  // follow: the arrangement, a binding, a title, an identity, a body's facts,
  // the bindings ledger a parked card's title resolves through, and a
  // session's subprocess coming or going.
  const publishDeckCards = (): void => {
    deckCards.set(
      projectDeckCards(deck, {
        title: (id) => cardTitleStore.get(id),
        masthead: (id) => cardTitleStore.getMasthead(id),
        identity: liveCardIdentity,
        // A dormant or evicted body's phase follows its session, not the
        // facts it froze at.
        activity: bodilessFactsStore.activityOf,
        binding: (id) => cardSessionBindingStore.getBinding(id) ?? null,
        sessionState: (id) => {
          const address = cardSessionBindingStore.getBinding(id)?.tugSessionId;
          if (address === undefined) return null;
          const row = getSessionLedgerStore()?.findRow(ledgerSegmentForCard(id, address))?.state ?? null;
          return sessionStateOf(row, childStates.get(address) ?? null);
        },
        parkedTitle: (id) => {
          const identity = cardIdentity(id);
          return identity.source === "parked" ? identity.title : null;
        },
        waivesClose: (id) => bodyFactsStore.waives(id),
      }),
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
    publishDeckCards();
  };
  publishArrangement();
  publishLedgerBindings();
  publishAppInfo();
  // The supervisor's last word on each session's subprocess, which this
  // page hears for every session: a live row whose child is gone answers
  // no catch-up, and a body reads that off its `deck.cards` record.
  releases.push(
    connection.onFrame(FeedId.SESSION_STATE, (payload) => {
      let frame: { tug_session_id?: unknown; state?: unknown };
      try {
        frame = JSON.parse(new TextDecoder().decode(payload)) as typeof frame;
      } catch {
        return;
      }
      if (typeof frame.tug_session_id !== "string" || typeof frame.state !== "string") return;
      if (childStates.get(frame.tug_session_id) === frame.state) return;
      childStates.set(frame.tug_session_id, frame.state);
      publishDeckCards();
    }),
  );

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
    postToHost(bodyFocusToHost, { cardId: target });
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
      // A raised surface hangs off its card, wherever the card now rests.
      surfaces.placeAll();
      const fr = deck.getFirstResponderCardId();
      if (fr !== lastFirstResponder) {
        lastFirstResponder = fr;
        // A press in another body never reaches the shell, but it makes
        // that card the first responder: the keyboard leaving a card closes
        // the surface raised for it, as the press would have.
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
    // The workspace's project set is keyed by the server's canonical spelling
    // of each binding's directory ([L29]); an answer landing can merge two.
    canonicalDirStore.subscribe(publishDeckFacts),
    motionBreaker.onChange(publishDeckFacts),
  );
  publishDeckFacts();
  // A workspace's live-session count reads the bindings and the bindings
  // cache, so a change to either is a change to the workspaces too.
  const publishSpaces = (): void => arrangementSpaces.set(projectArrangementSpaces(deck));
  releases.push(
    cardSessionBindingStore.subscribe(() => {
      publishDeckCards();
      publishSpaces();
    }),
    cardTitleStore.subscribe(() => {
      publishDeckCards();
      publishPaneChrome();
    }),
    cardIdentityElsewhere.subscribe(publishDeckCards),
    appInfoStore.subscribe(publishAppInfo),
    spaceBindingsLedgerStore.subscribe(() => {
      publishLedgerBindings();
      publishSpaces();
      publishDeckCards();
    }),
    // A body publishes on every telemetry tick; the store sends only when
    // some card's phase or waive moved. A waive is also its pane's close
    // asks (`closeAsksOf`), so the chrome follows it.
    bodyFactsStore.subscribe(() => {
      publishDeckCards();
      publishPaneChrome();
    }),
    // A bodiless card's phase moves with its session while its body hears
    // nothing of it.
    bodilessFactsStore.subscribe(publishDeckCards),
    // A card's session state is its ledger row's.
    subscribeSessionLedger(publishDeckCards),
    bodilessFactsStore.attach(),
    // A card whose page has not painted wears its chrome from the shell.
    bodyStandInStore.attach(),
    // The layout selection is the shell's, and the Cards list proposes to it.
    shareLayoutSelection(bus),
    // A body card's binding is the shell's, and its body proposes each change.
    shareCardBinding(bus),
    // The arc transport presses are the shell's, where their answers arrive:
    // a body proposes each press, and reads every press and refusal.
    shareArcPresses(bus),
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
  // The deck verbs any card makes. A card added from a body takes the id its
  // page minted, which the page has already handed on (a fresh spawn, a
  // flash), so a refusal for an unregistered kind is said here.
  releases.push(
    deckAddCard.handle(({ cardId, componentId, initialContent, origin, opening }) => {
      if (deck.addCard(componentId, initialContent, { origin, opening, cardId }) === null) {
        tugDevLogStore.warn("body", `deck.addCard: no registration for ${componentId}`, { cardId });
      }
    }),
    deckShowSingletonCard.handle(({ componentId }) => void deck.showSingletonCard(componentId)),
    deckInterruptLiveSessions.handle(() => deck.interruptLiveSessions()),
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

  /** Facts whose title waits on the card's paint ({@link applyFacts}). */
  const titleAtPaint = new Map<string, CardFactsValue>();
  const applyFacts = (cardId: string, facts: CardFactsValue): void => {
    cardIdentityElsewhere.set(cardId, facts.identity);
    paneTitleBarItemsStore.set(cardId, facts.titleBar);
    // A new page says its facts before it has read its own title: an empty
    // title with no masthead, from a page that has not painted, is not the
    // card's title, and drawn by the stand-in standing until the paint it
    // would blank a title the shell already holds. It is taken at the paint.
    if (
      facts.title === "" &&
      facts.masthead === null &&
      bodyCardsStore.stateOf(cardId) !== "painted" &&
      (cardTitleStore.get(cardId) ?? "") !== ""
    ) {
      titleAtPaint.set(cardId, facts);
      return;
    }
    titleAtPaint.delete(cardId);
    if (facts.masthead !== null) {
      cardTitleStore.set(cardId, facts.title, facts.masthead);
    } else {
      cardTitleStore.set(cardId, facts.title);
    }
  };
  releases.push(
    bodyCardsStore.subscribe(() => {
      for (const [cardId, facts] of [...titleAtPaint]) {
        const state = bodyCardsStore.stateOf(cardId);
        if (state === null) titleAtPaint.delete(cardId);
        else if (state === "painted") applyFacts(cardId, facts);
      }
    }),
  );

  /**
   * The holds the shell keeps for a body card in its own stores, moved with
   * the card's: the close guard it holds once the card says it has one, the
   * modal hold, and the chord capture. The close advice and the fold guard
   * are read from the replica at gesture time (`bodyFactsStore`).
   */
  const applyHolds = (cardId: string, holds: CardHoldsValue, prev: CardHoldsValue): void => {
    if (holds.closeGuardAsks !== null) holdCloseGuard(cardId);
    keptWords.heard(cardId, holds);
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
      // A parked card's picker can report while its workspace is hidden: its
      // claim goes on the parked record the return swaps in, so the arrival
      // is laid out at the floor it needs.
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
  watchCardStore(cardSurface, (cardId, surface: CardSurface | null) => surfaces.set(cardId, surface));

  /** The body card a verb came from, when it is one this shell holds. */
  const fromBody = (from: { cardId: string | null }): string | null =>
    from.cardId !== null && bodyCardsStore.has(from.cardId) ? from.cardId : null;
  releases.push(
    cardActivate.handle(({ reveal }, from) => {
      const cardId = fromBody(from);
      if (cardId === null) return;
      // A parked body cannot be pressed: an activation from one — a warm
      // workspace's card taking focus in its own page — is not the user's,
      // and would name a key card the deck does not show.
      if (!cardContextFor(deck, cardId).layerShown) return;
      if (reveal === false) deck.activateCard(cardId, { reveal: false });
      else deck.activateCard(cardId);
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
  );

  /**
   * The pane a chrome verb from a body acts on, or null: the sender must be a
   * body card on the shown layer — a parked card's chrome cannot be pressed,
   * as a hidden layer's frames take no interaction — and a card the verb
   * names must be of the sender's own pane.
   */
  const pressedPane = (from: { cardId: string | null }, target?: string): string | null => {
    const cardId = fromBody(from);
    if (cardId === null || !cardContextFor(deck, cardId).layerShown) return null;
    return paneVerbAddress(deck.getSnapshot(), cardId, target);
  };
  releases.push(
    paneSelectTab.handle(({ cardId }, from) => {
      const paneId = pressedPane(from, cardId);
      if (paneId !== null) selectTab(deck, paneId, cardId);
    }),
    paneCloseCard.handle(({ cardId }, from) => {
      const paneId = pressedPane(from, cardId);
      if (paneId !== null) closeTab(deck, paneId, cardId);
    }),
    paneClosePane.handle((_payload, from) => {
      const paneId = pressedPane(from);
      if (paneId === null) return;
      // The page that pressed the × has asked its own card: its confirm, its
      // hold and its guard are in that page. The pane's other cards are this
      // shell's to ask, through the holds and guards it keeps for their
      // bodies, visiting each dirty one before the pane goes.
      const sender = fromBody(from);
      const others = (deck.getSnapshot().panes.find((p) => p.id === paneId)?.cardIds ?? []).filter((id) => id !== sender);
      const held = others.find((id) => isCardHeld(cardModalHoldStore.getSnapshot(), id));
      if (held !== undefined) {
        refuseCardModalHold(held);
        return;
      }
      const walk = closeGuardWalk(
        others,
        (id) => selectTab(deck, paneId, id),
        (id) => deck.getSnapshot().panes.find((p) => p.id === paneId)?.activeCardId === id,
      );
      if (walk === null) {
        closePane(deck, paneId);
        return;
      }
      void walk().then((answer) => {
        if (answer === "close") closePane(deck, paneId);
      });
    }),
    paneReorderTabs.handle(({ fromIndex, toIndex }, from) => {
      const paneId = pressedPane(from);
      if (paneId !== null) deck.reorderCardInPane(paneId, fromIndex, toIndex);
    }),
    // A tab dragged past its own bar in a card's page: the point is the
    // page's, offset here by where its view stands. The merge targets are the
    // other panes' title bands, read off their frames, so a stand-in is one
    // as a pane the shell draws is; anywhere else, the drop detaches. The
    // band and the tab's ghost are drawn in the overlay, above every card
    // ([B08]).
    paneTabDrag.handle(({ phase, cardId, x, y, ghost }, from) => {
      const paneId = pressedPane(from, cardId);
      const sender = fromBody(from);
      if (phase !== "move") indicate({ band: null, ghost: null });
      if (paneId === null || sender === null || phase === "cancel") return;
      const view = cardPlacementDiag()?.lastPosted?.bodies.find((b) => b.cardId === sender);
      if (view === undefined) return;
      const point = { x: view.x + x, y: view.y + y };
      const target = tabMergeTargetAt(deck, point, paneId);
      if (phase === "move") {
        indicate({
          band: target?.band ?? null,
          ghost: ghost === undefined ? null : { ...ghost, x: view.x + ghost.x, y: view.y + ghost.y },
        });
        return;
      }
      if (target !== null) {
        deck.moveCardToPane(paneId, cardId, target.paneId, 999);
        return;
      }
      const root = deckRootElement().getBoundingClientRect();
      deck.detachCard(paneId, cardId, { x: layoutPxOf(point.x - root.left), y: layoutPxOf(point.y - root.top) });
    }),
    paneSetWidth.handle(({ preset }, from) => {
      const paneId = pressedPane(from);
      if (paneId !== null) setPaneWidth(paneId, preset);
    }),
    paneFillHeight.handle((_payload, from) => {
      const paneId = pressedPane(from);
      if (paneId !== null) fillPaneHeight(paneId);
    }),
    paneArrangePlace.handle(({ verb }, from) => {
      const paneId = pressedPane(from);
      if (paneId === null) return;
      const slot = placeSlotOf(deck.getSnapshot(), paneId);
      if (slot === null) return;
      arrangePlace(slot, verb === "place:split" ? "split" : verb === "place:stack" ? "stack" : "equalize");
    }),
    paneToggleBullseye.handle((_payload, from) => {
      const paneId = pressedPane(from);
      if (paneId !== null) togglePaneBullseye(paneId);
    }),
    paneMoveToSpace.handle(({ spaceId }, from) => {
      const paneId = pressedPane(from);
      if (paneId !== null) moveActiveCardToSpace(deck, paneId, spaceId);
    }),
    paneRevealStackEntry.handle(({ paneId: entryPaneId }, from) => {
      const paneId = pressedPane(from);
      if (paneId === null) return;
      const cardId = stackEntryCardOf(deck.getSnapshot(), paneId, entryPaneId);
      if (cardId !== null) revealStackEntry(deck, cardId);
    }),
    paneRevealCard.handle(({ cardId }, from) => {
      if (pressedPane(from, cardId) !== null) deck.revealCard(cardId);
    }),
    // The settle a reveal arms stands on the canvas the moment the store
    // notifies, so the travel is read straight after it: the settle's length
    // while one runs, none when the reveal moved nothing.
    paneRevealForQuestion.handle(({ cardId }, from) => {
      if (pressedPane(from, cardId) === null) return { travelMs: 0 };
      deck.revealCard(cardId);
      const canvas = document.querySelector<HTMLElement>(`[${CANVAS_BACKGROUND_ATTRIBUTE}]`);
      if (canvas === null || !canvas.hasAttribute("data-imposer-settling")) return { travelMs: 0 };
      return { travelMs: readSettleMs(canvas) * getTugTiming() };
    }),
  );

  releases.push(
    // The body's chain did not answer it; this one does, and never sends it
    // back ([P04]: one front door, routed by the entry).
    answerBodyCommands(bus),
    appLogout.handle((_payload, from) => {
      // From a body card's page, or from the overlay's setup wizard, whose
      // Log Out… is this same request ([B07]).
      if (fromBody(from) === null && from.cardId !== OVERLAY_CARD_ID) return;
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

  const releaseBodyState = onHostMessage(bodyStateToPage, (report) => {
    const cardId = report.cardId;
    if (!bodyCardsStore.has(cardId)) return;
    switch (report.state) {
      case "ready":
        bodyCardsStore.setState(cardId, "ready");
        failures.delete(cardId);
        // The body exists now; if its card holds the keyboard, it takes it.
        if (deck.getFirstResponderCardId() === cardId) postFocus(true);
        return;
      case "painted":
        // Its first frame of content is composited; the placer may show it
        // once the bus has said so too, and the facts the frame drew are in.
        // A card says this at its first chrome frame, and shows from here;
        // the gate still waits on `card.painted`.
        bodyCardsStore.markChromeShown(cardId);
        paintGate.hostPainted(cardId);
        return;
      case "landed":
        // The host ran the body's planned beats to their end.
        if (report.planId !== undefined) {
          cardPlanLanded(cardId, report.planId, report.lateMs ?? null);
        }
        return;
      case "beatsCancelled":
        // A placement or a newer plan took the body before it landed.
        if (report.planId !== undefined) cardPlanCancelled(cardId, report.planId);
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
        paintGate.forget(cardId);
        return;
      case "evicted":
        // The host gave the body's process up under memory pressure, once its
        // page had written the card's state. The card stays a body card, and
        // its facts stand — the masthead says what it said — while what only
        // the page held clears with the detach, as at a termination. A
        // placement that wants it shown asks for it again; one that already
        // does, a reveal racing the eviction, asks now.
        // A page that said its guard would ask leaves that word behind: the
        // card's close asks until its next page answers for itself.
        keptWords.evicted(cardId, cardHolds.getFor(cardId));
        bodyCardsStore.setState(cardId, "evicted");
        bus.detach(cardId);
        paintGate.forget(cardId);
        reviveWanted();
        return;
      case "covered":
        // The body asked for to bring an evicted card back stands under the
        // card's last frame, which the host keeps until its page paints: the
        // placer may show it from here — but not ahead of the shell's own
        // frame. The host shows a view the moment a placement names it,
        // while the commit that asked for the card (a workspace switch, a tab
        // chosen) may not have composited, so a covered card shown at once
        // stands on the bare canvas beside the other cards' stand-in faces,
        // which come with the shell's frame. Waited two paints, as a view
        // taken down is held, the face is on screen first and the cover
        // comes up over it. A card the host had no cover for never hears
        // this, and stands under its stand-in until `painted`.
        scheduleAfterPaint(() => scheduleAfterPaint(() => bodyCardsStore.markRevived(cardId)));
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
        paintGate.forget(cardId);
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
  });
  releases.push(releaseBodyState);

  // ---- Evicted cards, brought back when they are wanted ----

  /**
   * Ask for every evicted or unmade card the deck now wants shown — its
   * tab chosen, its workspace shown, its pane unfolded. An evicted one comes
   * back as an arrival, never by un-evicting a view that is gone: a new body on the
   * restore path, which reads the state the evicted page wrote as it went.
   * Where the host kept the card's last frame it stands it over the new
   * body and says `covered`, and the placer shows the card from there;
   * where it kept none the stand-in stands until the page paints.
   *
   * An unmade card — handed off while it was not shown — is asked for with
   * the intent it was handed, and stands behind its stand-in until its page
   * paints, having no last frame to show.
   */
  function reviveWanted(): void {
    for (const cardId of bodyCardsStore.cardIds()) {
      const state = bodyCardsStore.stateOf(cardId);
      if (!pageless(state) || !wantsBodyShown(deck, cardId)) continue;
      if (state === "unmade") releaseDeferredBody(cardId);
      else askAgain(cardId);
    }
  }
  releases.push(deck.subscribe(reviveWanted), deck.subscribeSpaces(reviveWanted));

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
  let pointerUpTimer: number | null = null;
  const onShellPointerUp = (): void => {
    if (pointerUpTimer !== null) window.clearTimeout(pointerUpTimer);
    pointerUpTimer = window.setTimeout(() => {
      pointerUpTimer = null;
      if (keyboardBody() !== null && !shellAheadNow()) postFocus(true);
    }, 0);
  };
  window.addEventListener("pointerup", onShellPointerUp, true);
  releases.push(() => {
    window.removeEventListener("pointerup", onShellPointerUp, true);
    // The uninstall leaves no timer behind to post into a shell that is gone.
    if (pointerUpTimer !== null) window.clearTimeout(pointerUpTimer);
    pointerUpTimer = null;
  });

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
