/**
 * The shell's picture of its body cards, kept current both ways.
 *
 * A body card's content lives in another document, so everything the shell
 * read from the card in its own page arrives instead over the bus, and
 * everything the card read from the deck goes to it the same way:
 *
 * - The host's `onBodyState` moves a card through `bodyCardsStore`; a body
 *   that failed leaves the card to the shell for the rest of the run.
 * - The body's `card-facts` set the card's title and masthead and feed
 *   `bodyFactsStore`; its `card-advice` answers the shell's close advisor and
 *   fold guard, claims sheet reservations and opening bids on the member the
 *   card stands as, activates the card, adds a sibling to its pane, and
 *   closes it.
 * - The shell sends `deck-facts` to every body on change, and each card's
 *   `card-context` when its fold, arrival, first responder or layer changes,
 *   answering a card's first `card-facts` with both.
 * - `bodyFocus` goes to the host on every first-responder change, so the
 *   keyboard follows the deck's first responder into a body and out again.
 * - A body card's Tab walk may be split: its own stops in the body, its
 *   chrome's here (none a Session card has: it authors its own folded form,
 *   so it wears no Unfold glyph). A body's walk that runs off an end posts
 *   `focus-exit`; the shell lands its own first or last stop of the card,
 *   or with none sends `focus-enter` back at the end the walk came in by.
 *   The shell's walk running off an end goes into the body the same way,
 *   and a step of it while the shell holds none of the card's stops is the
 *   body's. While the shell holds a stop of the card's, it holds the keyboard.
 * - A destroyed card's body is destroyed with it, unsaved: its bag is about
 *   to be swept.
 * - A surface a body card raises past its content box — the Z2 placard —
 *   arrives as `surface` advice and is drawn here, over the deck, where the
 *   in-document card would have drawn it (`shell-surface.ts`); a press in it
 *   or its dismissal goes back as a `card-command`. A body's `logout` advice
 *   is the app's logout, which only the shell mounts.
 * - A menu command bound for the key card goes to the key body when the key
 *   card is one and no shell surface holds the chain ahead of it.
 * - A card that lists or moves the whole deck (`bodyDeck: "arrangement"`)
 *   gets the shell's arrangement in its `card-context`, resent when the
 *   deck, the workspaces, or any card's binding or title moves; the deck
 *   calls it makes come back as `deck-call` advice, run only for a method
 *   in `BODY_DECK_CALLS`. A card that follows another (`bodyFollows`) gets
 *   the followed card — the last key card that is not it — and its binding.
 *   A devtools body following a body card has that card's session
 *   inspection relayed to it: the shell asks the followed body to publish
 *   (`inspect`), forwards each `inspection` advice as an `inspection`
 *   command, and stops it when no devtools body follows the card. The
 *   devtools body is also sent this page's dev log (`dev-log`), the About
 *   body the app identity the host sent this page (`appInfo` in its
 *   context), and the Settings body any section reveal parked here.
 * - A body card whose close guard would ask says so (`close-guard`); the
 *   shell then holds a close guard for it that fronts the card and asks the
 *   body's own guard (`close-decision`), so a close here, or a walk over a
 *   workspace, waits on the sheet the body raises in the card it concerns.
 *
 * Laws: [L02] (the stores are read through `useSyncExternalStore`), [L22]
 * (advisors read the store directly), [L27] (every registration released),
 * [L33] (a close decision waits on the body's answer, its going away, or —
 * while the body said its guard would not ask — a deadline).
 *
 * @module lib/body-shell
 */

import type { BusMasthead, CardAdvice, CardContext, CardFacts, DeckFacts } from "@tugproto/bus";
import type { TugConnection } from "../connection";
import type { IDeckManagerStore } from "../deck-manager-store";
import type { DeckState } from "../layout-tree";
import { getResponderChainManager } from "../action-registry";
import { dispatchCommand, setCardContentForwarder, setKeyCardForwarder } from "../command-dispatch";
import { enterKeyViewWalk, getFocusManager } from "../components/tugways/focus-manager";
import { TUG_ACTIONS } from "./action-vocabulary";
import { setFocusWalkEdge } from "./focus-walk-edge";
import { setKeyboardYield } from "./keyboard-yield";
import { getOnScreenTheme, subscribeOnScreenTheme } from "../contexts/theme-provider";
import { cardArrivingOf, cardFoldedOf } from "../deck-store-selectors";
import { keyboardAccessStore } from "../keyboard-access-store";
import { focusRingModalityStore } from "../focus-ring-modality-store";
import { heldModifiers, subscribeModifierLatch } from "../components/tugways/modifier-latch";
import { projectDeckState } from "./host-menu-state";
import { focusTravelDirections } from "./directional-focus";
import { bodyCardsStore } from "./body-cards-store";
import { bodyCommandRoute, shellSurfaceAhead } from "./body-command-route";
import { bodyFactsStore } from "./body-facts-store";
import { bodyBeatsCancelled, bodyBeatsLanded, bodyShown, floorShown } from "./body-placement";
import { registerCardCloseAdvice } from "./card-close-advice";
import { registerCardFoldGuard } from "./card-fold";
import { cardSessionBindingStore } from "./card-session-binding-store";
import { cardTitleStore, type CardMastheadPayload } from "./card-title-store";
import { CARDS_CARD_ID } from "./cards-card-id";
import { cardsSpaceVerbRequest } from "@/components/cards/cards-space-verb-request";
import { requestLogout } from "./logout-store";
import { ShellSurfaceDrawer } from "./shell-surface";
import { onBus, sendBus } from "./deck-bus";
import { replayBodyIntent } from "../body/body-intent";
import {
  bodyIntentOf,
  forgetBodyIntent,
  handOffToBody,
  hostCapabilitiesStore,
  isMountBodyKind,
  postToHost,
  suppressHandOff,
} from "./body-handoff";
import { openingBidForCard } from "./opening-bid";
import { pageZoomStore } from "./page-zoom-store";
import { sheetReservationMemberIdOf } from "./sheet-reservation";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";
import { getRegistration, isSidebarCard, type CardIdentityFacts } from "../card-registry";
import { cardIdentityElsewhere, liveCardIdentity } from "./card-identity";
import { paneTitleBarItemsStore, type PaneTitleBarItem } from "./pane-title-bar-items-store";
import { setBodyLineRevealer } from "./open-file-in-card";
import { isSidebarPinned, sidebarSide, type SidebarSide } from "./layout-imposer";
import { isBodyDeckCall, projectActivities, projectArrangement } from "./body-arrangement";
import { registerCardCloseGuard } from "./card-close-guard";
import { appInfoStore } from "./app-info-store";
import { registerSettingsRevealConsumer } from "./settings-reveal";
import type { TugDevLogEntry } from "./tug-dev-log-store/types";

/** The kinds the shell relays something of its own to, by their component ids. */
const DEVTOOLS_KIND = "devtools";
const SETTINGS_KIND = "settings";
const ABOUT_KIND = "about";

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
 * How long the shell waits on a body's close decision when the body last
 * said its guard would not ask: an answer that needs nobody is immediate, so
 * a body silent this long is not answering, and the close is cancelled and
 * logged rather than left pending. A guard that asks waits on its person,
 * and ends with the answer or the body going away.
 */
const BODY_CLOSE_ANSWER_MS = 2000;

/** The `card-context` the shell owes `cardId`'s body now. */
export function cardContextFor(deck: IDeckManagerStore, cardId: string): CardContext {
  const state = deck.getSnapshot();
  const spaceId = deck.spaceOf(cardId);
  const activeSpaceId = deck.getSpacesSnapshot().activeSpaceId;
  const railSide = pinnedRailSideOf(state, cardId);
  return {
    folded: cardFoldedOf(state, cardId),
    arriving: cardArrivingOf(state, cardId),
    firstResponderCardId: deck.getFirstResponderCardId(),
    layerShown: spaceId === null || spaceId === activeSpaceId,
    spaceId,
    ...(railSide !== null ? { railSide } : {}),
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

function readDeckFacts(deck: IDeckManagerStore): DeckFacts {
  const state = deck.getSnapshot();
  return {
    theme: getOnScreenTheme(),
    zoom: pageZoomStore.getFactor(),
    keyboardAccess: keyboardAccessStore.getMode() === "accessibility",
    // What the shell's own key events say is held: a body sees no keys
    // while the shell has the keyboard, and its chord rings read this.
    modifierLatch: heldModifiers(),
    focusRingModality: focusRingModalityStore.getMode(),
    appActive: state.hasFocus,
    // The arrangement's menu facts, which a body's one-card deck cannot
    // project for itself: the gates a body posts for its card's Go, View and
    // Window items read these ([F19]).
    menu: {
      projection: projectDeckState(state, deck.getSpacesSnapshot()),
      focusTravel: focusTravelDirections(
        state,
        { rail: deck.getRailRunHeight(), column: deck.getColumnRunHeight() },
        deck.getFirstResponderCardId(),
      ),
    },
  };
}

/**
 * Wire the shell to its bodies. Called once from the deck's boot, after the
 * deck exists; a no-op when the host makes no bodies. Returns the uninstall.
 */
export function installBodyShell(connection: TugConnection, deck: IDeckManagerStore): () => void {
  if (!hostCapabilitiesStore.get().bodyViews) return () => {};
  const releases: Array<() => void> = [];

  // ---- Per-card registrations, held while the card is a body card ----

  const perCard = new Map<string, () => void>();
  /** Cards whose body has spoken, so their first `card-facts` is answered. */
  const heard = new Set<string>();
  /** The last `card-context` sent each card, as JSON. */
  const sentContext = new Map<string, string>();
  /** Cards that have shown a masthead, so its going away clears the binding. */
  const hadMasthead = new Set<string>();
  /**
   * Which halves of each body's paint the shell has heard: the host's (its
   * first frame composited) and the bus's (sent behind every `card-facts` that
   * frame was drawn with). The card is `painted` to the placer only once both
   * have arrived, so a body is never shown under chrome its facts are still on
   * their way to change — a Session card's masthead, which grows the title
   * bar by 52 pt (`at0738-body-arrival`).
   */
  const paintHeard = new Map<string, { host: boolean; bus: boolean }>();
  const notePaint = (cardId: string, half: "host" | "bus"): void => {
    const heardPaint = { ...(paintHeard.get(cardId) ?? { host: false, bus: false }), [half]: true };
    paintHeard.set(cardId, heardPaint);
    if (heardPaint.host && heardPaint.bus) bodyCardsStore.setState(cardId, "painted");
  };
  /** The member each card's sheet reservation was claimed under. */
  const reservedUnder = new Map<string, string>();
  /** Each body card's deck-scope surface, drawn over the deck. */
  const surfaces = new ShellSurfaceDrawer({
    onActivate: (cardId, path) => {
      sendBus(connection, { card: cardId }, { kind: "card-command", payload: { command: "surface-activate", path } });
    },
    onDismiss: (cardId) => {
      sendBus(connection, { card: cardId }, { kind: "card-command", payload: { command: "surface-dismissed" } });
    },
  });
  releases.push(() => surfaces.dispose());

  /** The shell's close guard held for each body card whose guard spoke, with its release. */
  const closeGuards = new Map<string, () => void>();
  /** Whether each such body's guard would ask, as it last said. */
  const closeAsks = new Map<string, boolean>();
  /** The close decision each body card owes, while one is asked. */
  const pendingDecisions = new Map<string, (answer: "close" | "cancel") => void>();
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
    heard.delete(cardId);
    sentContext.delete(cardId);
    hadMasthead.delete(cardId);
    reservedUnder.delete(cardId);
    paintHeard.delete(cardId);
    surfaces.remove(cardId);
    closeGuards.get(cardId)?.();
    closeGuards.delete(cardId);
    cardIdentityElsewhere.set(cardId, null);
    paneTitleBarItemsStore.set(cardId, null);
    closeAsks.delete(cardId);
    pendingDecisions.get(cardId)?.("cancel");
    followedOf.delete(cardId);
    settingsReveals.get(cardId)?.();
    settingsReveals.delete(cardId);
    devLogRelays.get(cardId)?.();
    devLogRelays.delete(cardId);
    syncInspection();
  };

  /** The registration of the kind `cardId` is, if the deck holds it. */
  const registrationOf = (cardId: string) => {
    const card = deck.getSnapshot().cards.find((c) => c.id === cardId);
    return card === undefined ? undefined : getRegistration(card.componentId);
  };
  const kindOf = (cardId: string): string | undefined => registrationOf(cardId)?.componentId;

  /**
   * Keep each body card's inspection publisher running exactly while a
   * devtools body follows it: ask a newly followed body to publish, tell
   * one nobody follows to stop, and empty a devtools body's inspection when
   * the card it follows changed so it never shows the card it left.
   */
  const syncInspection = (): void => {
    const wanted = new Map<string, Set<string>>();
    for (const devtools of heard) {
      if (kindOf(devtools) !== DEVTOOLS_KIND) continue;
      const followed = followedOf.get(devtools);
      if (followed === undefined || !bodyCardsStore.has(followed)) continue;
      let set = wanted.get(followed);
      if (set === undefined) wanted.set(followed, (set = new Set()));
      set.add(devtools);
    }
    for (const [followed, had] of [...inspecting]) {
      const now = wanted.get(followed);
      if (now === undefined) {
        inspecting.delete(followed);
        if (bodyCardsStore.has(followed)) {
          sendBus(connection, { card: followed }, { kind: "card-command", payload: { command: "inspect", on: false } });
        }
      }
      for (const devtools of had) {
        if ((now === undefined || !now.has(devtools)) && heard.has(devtools)) {
          sendBus(connection, { card: devtools }, { kind: "card-command", payload: { command: "inspection", inspection: null } });
        }
      }
    }
    for (const [followed, set] of wanted) {
      const had = inspecting.get(followed);
      inspecting.set(followed, set);
      // A devtools body that joined a card already publishing hears the
      // current inspection only if the publisher starts over.
      if (had === undefined || [...set].some((d) => !had.has(d))) {
        sendBus(connection, { card: followed }, { kind: "card-command", payload: { command: "inspect", on: true } });
      }
    }
  };

  /** Send `cardId`'s devtools body this page's dev log: all of it now, then each entry as it lands. */
  const relayDevLog = (cardId: string): void => {
    if (devLogRelays.has(cardId)) return;
    let sentThrough = 0;
    const send = (): void => {
      const entries = tugDevLogStore.getSnapshot().entries.filter((e) => e.id > sentThrough);
      if (entries.length === 0) return;
      sentThrough = entries[entries.length - 1].id;
      sendBus(
        connection,
        { card: cardId },
        { kind: "card-command", payload: { command: "dev-log", payload: { entries: entries.map(relayableLogEntry) } } },
      );
    };
    devLogRelays.set(cardId, tugDevLogStore.subscribe(send));
    send();
  };

  /** Hold the Settings reveal consumer for `cardId`'s body, flushing any parked request into it. */
  const relaySettingsReveal = (cardId: string): void => {
    if (settingsReveals.has(cardId)) return;
    settingsReveals.set(
      cardId,
      registerSettingsRevealConsumer((section) => {
        sendBus(connection, { card: cardId }, { kind: "card-command", payload: { command: "reveal-settings", payload: { section } } });
      }),
    );
  };

  /** Hold a close guard for `cardId` that asks its body's own guard. */
  const holdCloseGuard = (cardId: string): void => {
    if (closeGuards.has(cardId)) return;
    const release = registerCardCloseGuard(cardId, {
      needsDecision: () => closeAsks.get(cardId) === true,
      run: () =>
        new Promise<"close" | "cancel">((resolve) => {
          pendingDecisions.get(cardId)?.("cancel");
          let timer: ReturnType<typeof setTimeout> | null = null;
          const settle = (answer: "close" | "cancel"): void => {
            if (timer !== null) clearTimeout(timer);
            if (pendingDecisions.get(cardId) === settle) pendingDecisions.delete(cardId);
            resolve(answer);
          };
          pendingDecisions.set(cardId, settle);
          if (closeAsks.get(cardId) !== true) {
            timer = setTimeout(() => {
              tugDevLogStore.error("body", "a body did not answer its close decision; the close is cancelled", { cardId });
              settle("cancel");
            }, BODY_CLOSE_ANSWER_MS);
          }
          sendBus(connection, { card: cardId }, { kind: "card-command", payload: { command: "close-decision" } });
        }),
    });
    closeGuards.set(cardId, release);
  };

  /** What a body card's context carries beyond its own card: the arrangement, the followed card, the app identity. */
  const contextExtras = (cardId: string): Pick<CardContext, "arrangement" | "followed" | "appInfo"> => {
    const registration = registrationOf(cardId);
    const extras: Pick<CardContext, "arrangement" | "followed" | "appInfo"> = {};
    if (registration?.bodyDeck === "arrangement") {
      const arrangement = projectArrangement(
        deck,
        (id) => cardSessionBindingStore.getBinding(id),
        (id) => {
          const title = cardTitleStore.get(id);
          const masthead = cardTitleStore.getMasthead(id);
          return title === null && masthead === null ? null : { title, masthead };
        },
        liveCardIdentity,
        bodyFactsStore.activityOf,
      );
      arrangement.spaceVerb = cardsSpaceVerbRequest.getSnapshot();
      extras.arrangement = arrangement;
    }
    if (registration?.bodyFollows === true) {
      const followed = followedOf.get(cardId) ?? null;
      extras.followed =
        followed === null ? null : { cardId: followed, binding: cardSessionBindingStore.getBinding(followed) ?? null };
    }
    if (registration?.componentId === ABOUT_KIND) {
      // The host sends the app's identity with its `show-card`, which only
      // this page hears; the About body reads it from its context.
      const info = appInfoStore.getSnapshot();
      if (info !== null) extras.appInfo = info;
    }
    return extras;
  };

  /** Whether `cardId`'s context carries anything beyond its own card. */
  const hasExtras = (cardId: string): boolean => {
    const registration = registrationOf(cardId);
    return (
      registration?.bodyDeck === "arrangement" ||
      registration?.bodyFollows === true ||
      registration?.componentId === ABOUT_KIND
    );
  };

  const attach = (cardId: string): void => {
    const unregs = [
      registerCardCloseAdvice(cardId, () => ({ waive: bodyFactsStore.waives(cardId) })),
      registerCardFoldGuard(cardId, () => bodyFactsStore.guarded(cardId)),
      deck.observeCardWillBeginDestruction(cardId, () => {
        postToHost("bodyDestroy", { cardId, save: false });
        forget(cardId);
        bodyCardsStore.drop(cardId);
        bodyFactsStore.drop(cardId);
      }),
    ];
    perCard.set(cardId, () => {
      for (const unreg of unregs) unreg();
    });
  };

  const syncCards = (): void => {
    const ids = bodyCardsStore.cardIds();
    for (const cardId of ids) {
      if (!perCard.has(cardId)) attach(cardId);
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
  const handOffMountKinds = (): void => {
    for (const card of deck.getSnapshot().cards) {
      if (bodyCardsStore.has(card.id) || !isMountBodyKind(card.componentId)) continue;
      // The card's state goes with it: the shell holds a just-added card's
      // seed in memory, ahead of any write the body could read back.
      handOffToBody(card.id, () => {
        const bag = deck.getCardState(card.id);
        return bag === undefined ? { kind: "mount" } : { kind: "mount", bag };
      });
    }
  };
  releases.push(deck.subscribe(handOffMountKinds));
  handOffMountKinds();

  // ---- What the shell tells its bodies ----

  let sentDeckFacts = "";
  const publishDeckFacts = (): void => {
    if (bodyCardsStore.cardIds().length === 0) return;
    const facts = readDeckFacts(deck);
    const json = JSON.stringify(facts);
    if (json === sentDeckFacts) return;
    sentDeckFacts = json;
    sendBus(connection, "body", { kind: "deck-facts", payload: facts });
  };

  const sendContext = (cardId: string, force: boolean): void => {
    const context: CardContext = { ...cardContextFor(deck, cardId), ...contextExtras(cardId) };
    const json = JSON.stringify(context);
    if (!force && sentContext.get(cardId) === json) return;
    sentContext.set(cardId, json);
    sendBus(connection, { card: cardId }, { kind: "card-context", payload: context });
  };

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
  const keyboardBody = (): string | null => {
    const fr = deck.getFirstResponderCardId();
    return fr !== null && bodyCardsStore.has(fr) && !shellHoldsStop(fr) ? fr : null;
  };
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
      let moved = false;
      for (const cardId of heard) {
        if (key === cardId || registrationOf(cardId)?.bodyFollows !== true) continue;
        if (followedOf.get(cardId) !== key) {
          followedOf.set(cardId, key);
          moved = true;
        }
      }
      if (moved) for (const cardId of heard) sendContext(cardId, false);
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
      for (const cardId of heard) sendContext(cardId, false);
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
      for (const cardId of heard) sendContext(cardId, false);
      // The menu facts project the workspaces too, and a workspace made or
      // renamed moves no deck state.
      publishDeckFacts();
    }),
    subscribeOnScreenTheme(publishDeckFacts),
    pageZoomStore.subscribe(publishDeckFacts),
    keyboardAccessStore.subscribe(publishDeckFacts),
    focusRingModalityStore.subscribe(publishDeckFacts),
    subscribeModifierLatch(publishDeckFacts),
  );
  // An arrangement card lists every card's binding and title, and a
  // following card names its followed card's binding: a change to either
  // store is a change to what those cards were sent.
  const resendExtras = (): void => {
    for (const cardId of heard) if (hasExtras(cardId)) sendContext(cardId, false);
  };
  let sentActivities = JSON.stringify(projectActivities(deck, bodyFactsStore.activityOf));
  releases.push(
    cardSessionBindingStore.subscribe(resendExtras),
    cardTitleStore.subscribe(resendExtras),
    cardIdentityElsewhere.subscribe(resendExtras),
    appInfoStore.subscribe(resendExtras),
    // An arrangement card lists every card's phase too, read from what each
    // body reported. A body publishes on every telemetry tick as well, so
    // the resend waits for some card's phase to move ([B06]).
    bodyFactsStore.subscribe(() => {
      const activities = JSON.stringify(projectActivities(deck, bodyFactsStore.activityOf));
      if (activities === sentActivities) return;
      sentActivities = activities;
      for (const cardId of heard) if (registrationOf(cardId)?.bodyDeck === "arrangement") sendContext(cardId, false);
    }),
    // A followed card's body may come up after the devtools body did: a
    // session spawned into it, or the card re-adopted.
    bodyCardsStore.subscribe(syncInspection),
  );
  // An arrangement card hears a commit in the commit's own task, not a
  // painted frame later: the deferral keeps this page's React commit off a
  // motion's first frame, and a body renders in its own page. A row press in
  // the Layout body comes back a frame sooner; the deferred send that follows
  // finds the same context and sends nothing.
  if (deck.subscribeSync !== undefined) releases.push(deck.subscribeSync(() => resendExtras(), "body-arrangement"));
  // A workspace verb the menu asked the Cards card to answer lands in this
  // page's slot, which a Cards body never reads: it goes to every Cards body
  // on its arrangement, and leaves the slot once one has been sent it. With
  // no Cards body heard yet — the verb also reveals the card — it waits for
  // the first one.
  const relaySpaceVerb = (): void => {
    if (cardsSpaceVerbRequest.getSnapshot() === null) return;
    const cardsBodies = [...heard].filter((id) => registrationOf(id)?.componentId === CARDS_CARD_ID);
    if (cardsBodies.length === 0) return;
    for (const cardId of cardsBodies) sendContext(cardId, false);
    cardsSpaceVerbRequest.clear();
  };
  releases.push(cardsSpaceVerbRequest.subscribe(relaySpaceVerb));

  // ---- What the bodies tell the shell ----

  releases.push(
    onBus(connection, "card-facts", (message) => {
      const cardId = message.from.cardId;
      if (cardId === null || !bodyCardsStore.has(cardId)) return;
      applyFacts(cardId, message.payload);
      if (!heard.has(cardId)) {
        heard.add(cardId);
        // A following card's history starts with the latest key card that is
        // not itself — the one it was opened over.
        const key = getFocusManager()?.keyCard() ?? null;
        if (key !== null) noteKey(key);
        const prior = recentKeys.find((k) => k !== cardId) ?? null;
        if (prior !== null && registrationOf(cardId)?.bodyFollows === true && !followedOf.has(cardId)) {
          followedOf.set(cardId, prior);
        }
        sendBus(connection, { card: cardId }, { kind: "deck-facts", payload: readDeckFacts(deck) });
        sendContext(cardId, true);
        relaySpaceVerb();
        const kind = kindOf(cardId);
        if (kind === DEVTOOLS_KIND) relayDevLog(cardId);
        if (kind === SETTINGS_KIND) relaySettingsReveal(cardId);
        syncInspection();
      }
    }),
    onBus(connection, "card-advice", (message) => {
      const cardId = message.from.cardId;
      if (cardId === null || !bodyCardsStore.has(cardId)) return;
      applyAdvice(cardId, message.payload);
    }),
  );

  const applyFacts = (cardId: string, facts: CardFacts): void => {
    if (!bodyFactsStore.applyFacts(cardId, facts)) return;
    cardIdentityElsewhere.set(cardId, (facts.identity ?? null) as CardIdentityFacts | null);
    paneTitleBarItemsStore.set(cardId, (facts.titleBar ?? null) as PaneTitleBarItem[] | null);
    const masthead = facts.masthead as (BusMasthead & CardMastheadPayload) | null;
    if (masthead !== null) {
      hadMasthead.add(cardId);
      cardTitleStore.set(cardId, facts.title, masthead);
    } else {
      cardTitleStore.set(cardId, facts.title);
      // A masthead the body stops reporting is a card that let its session
      // go: the binding the shell keeps for it goes too.
      if (hadMasthead.delete(cardId)) cardSessionBindingStore.clearBinding(cardId);
    }
  };

  const applyAdvice = (cardId: string, advice: CardAdvice): void => {
    switch (advice.advice) {
      case "close-advice":
      case "fold-guard":
        bodyFactsStore.applyAdvice(cardId, advice);
        return;
      case "sheet-reservation": {
        const standing = sheetReservationMemberIdOf(deck.getSnapshot(), cardId);
        if (advice.heightPx === null) {
          const claimed = standing ?? reservedUnder.get(cardId);
          reservedUnder.delete(cardId);
          if (claimed !== undefined) deck.setSheetReservation(claimed, null);
          return;
        }
        if (standing === null) return;
        reservedUnder.set(cardId, standing);
        deck.setSheetReservation(standing, advice.heightPx);
        return;
      }
      case "opening-bid":
        openingBidForCard(cardId, advice.heightPx);
        return;
      case "activate":
        deck.activateCard(cardId);
        return;
      case "painted":
        notePaint(cardId, "bus");
        return;
      case "close-request": {
        const paneId = paneOf(deck.getSnapshot(), cardId);
        if (paneId !== null) deck.removeCard(paneId, cardId);
        return;
      }
      case "add-card": {
        const paneId = paneOf(deck.getSnapshot(), cardId);
        if (paneId !== null) deck.addCardToPane(paneId, advice.componentId);
        return;
      }
      case "dispatch":
        // The body's chain did not answer it; this one does, and never
        // forwards it back ([P04]: one front door, routed by the entry).
        dispatchCommand(advice.id, advice.payload, { local: true });
        return;
      case "focus-exit": {
        // The body's walk ran off an end: the card's chrome stops here come
        // next, from the end the walk arrived at; with none, the walk goes
        // back into the body — unless the body just said it has none either.
        if (deck.getFirstResponderCardId() !== cardId) return;
        const edge = advice.direction === "next" ? "first" : "last";
        const manager = getFocusManager();
        if (manager !== null && manager.keyCard() === cardId && enterKeyViewWalk(manager, edge)) {
          postFocus(false);
          return;
        }
        if (advice.empty !== true) enterBody(cardId, edge);
        return;
      }
      case "surface":
        surfaces.draw(cardId, advice.surface);
        return;
      case "logout":
        requestLogout();
        return;
      case "deck-call": {
        // Only the calls an arrangement card is allowed; anything else — a
        // workspace delete above all, which must walk the close guards — is
        // refused here and said so.
        if (!isBodyDeckCall(advice.method)) {
          tugDevLogStore.error("body", "a body asked for a deck call it may not make", { cardId, method: advice.method });
          return;
        }
        // Called on the deck: the flow-offset calls are prototype methods,
        // and a detached call loses its `this`.
        const method = deck[advice.method] as (...args: unknown[]) => unknown;
        method.apply(deck, advice.args);
        return;
      }
      case "close-guard":
        closeAsks.set(cardId, advice.asks);
        holdCloseGuard(cardId);
        return;
      case "close-decision":
        pendingDecisions.get(cardId)?.(advice.answer);
        return;
      case "inspection": {
        // The followed card's inspection goes to every devtools body following it.
        const to = inspecting.get(cardId);
        if (to === undefined) return;
        for (const devtools of to) {
          sendBus(connection, { card: devtools }, { kind: "card-command", payload: { command: "inspection", inspection: advice.inspection } });
        }
        return;
      }
    }
  };

  /** Hand the key card's walk into its body at `edge`, and the keyboard with it. */
  const enterBody = (cardId: string, edge: "first" | "last"): void => {
    const manager = getFocusManager();
    if (manager !== null && manager.keyCard() === cardId) manager.setKeyView(null);
    sendBus(connection, { card: cardId }, { kind: "card-command", payload: { command: "focus-enter", edge } });
    postFocus(false);
  };
  // A step of the shell's walk while a body card is key — the View menu's
  // Next / Previous Keyboard Focus, a Tab the shell holds — is the body's
  // to take while the shell holds none of the card's stops: it steps from
  // the body's own key view. Run off the end of the shell's chrome stops,
  // it goes into the body.
  releases.push(
    setFocusWalkEdge((direction) => {
      const fr = deck.getFirstResponderCardId();
      if (fr === null || !bodyCardsStore.has(fr)) return false;
      if (shellHoldsStop(fr)) {
        enterBody(fr, direction === 1 ? "first" : "last");
        return true;
      }
      const id = direction === 1 ? TUG_ACTIONS.NEXT_KEYBOARD_FOCUS : TUG_ACTIONS.PREVIOUS_KEYBOARD_FOCUS;
      sendBus(connection, { card: fr }, { kind: "card-command", payload: { command: "dispatch", id } });
      postFocus(false);
      return true;
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
        // The body exists now; if its card holds the keyboard, it takes it.
        if (deck.getFirstResponderCardId() === cardId) postFocus(true);
        return;
      case "painted":
        // Its first frame of content is composited; the placer may show it
        // once the bus has said so too, behind the facts the frame drew.
        notePaint(cardId, "host");
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
        // Reloading under the same card: its first `card-facts` is answered
        // again, since the page that heard the last answer is gone. The
        // masthead the old page showed goes with it: the new page reports
        // none until its restore binds, and that is a page starting, not a
        // card letting its session go — the binding the shell keeps stands.
        bodyCardsStore.setState(cardId, "creating");
        heard.delete(cardId);
        sentContext.delete(cardId);
        hadMasthead.delete(cardId);
        paintHeard.delete(cardId);
        surfaces.remove(cardId);
        // The page that would have answered a close decision is gone.
        pendingDecisions.get(cardId)?.("cancel");
        return;
      case "failed": {
        tugDevLogStore.error("body", "a body failed; its card stays in the shell", {
          cardId,
          cause: report.cause,
        });
        // The card is the shell's again. One the shell already holds a
        // binding for — the body's spawn was acknowledged, and the shell
        // heard the broadcast — mounts in the page on that binding, its
        // services built and replayed by the store's reconcile; re-running a
        // `new` or `fresh` intent there would spawn a second session. Only a
        // card with no binding re-runs what it was handed, through the
        // shell's own funnels now that hand-off is suppressed for it.
        const intent = bodyIntentOf(cardId);
        suppressHandOff(cardId);
        forget(cardId);
        bodyFactsStore.drop(cardId);
        forgetBodyIntent(cardId);
        // Marked failed before it goes, so an arrival waiting on the body
        // reveals now rather than at its bound.
        bodyCardsStore.setState(cardId, "failed");
        bodyCardsStore.drop(cardId);
        // A `mount` intent has nothing to re-run: the card mounts here.
        if (intent !== null && intent.kind !== "mount" && cardSessionBindingStore.getBinding(cardId) === undefined) {
          replayBodyIntent(intent, cardId, connection, deck, { inShell: true });
        }
        return;
      }
    }
  };
  releases.push(() => {
    delete bridge.onBodyState;
  });

  // ---- Menu commands bound for the key card ----

  /** Whether a shell surface holds the chain ahead of the deck's first-responder card. */
  const shellAheadNow = (): boolean => {
    const firstResponderCardId = deck.getFirstResponderCardId();
    const manager = getResponderChainManager();
    if (manager === null) return false;
    const paneId =
      firstResponderCardId === null ? null : paneOf(deck.getSnapshot(), firstResponderCardId);
    return shellSurfaceAhead({
      responder: manager.getFirstResponder() ?? null,
      paneId,
      cardId: firstResponderCardId,
      isWithin: (id, ancestorId) => manager.nodeIsWithin(id, ancestorId),
    });
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
    ),
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

  releases.push(
    setKeyCardForwarder((entry, payload) => {
      const firstResponderCardId = deck.getFirstResponderCardId();
      const target = bodyCommandRoute({
        routing: entry.routing,
        firstResponderCardId,
        isBodyCard: bodyCardsStore.has,
        shellResponderAhead: shellAheadNow(),
      });
      if (target === null) return false;
      sendBus(
        connection,
        { card: target },
        {
          kind: "card-command",
          payload: { command: "dispatch", id: entry.id, ...(payload !== undefined ? { payload } : {}) },
        },
      );
      // The keyboard follows: the shell may hold it (a popover it raised took
      // the click) while the deck's first responder is the body's card, and a
      // command that focuses something in the body is no use if keys still
      // land here.
      postFocus(true);
      return true;
    }),
  );

  // A chain action addressed to a body card's content runs in the body's own
  // chain, where that content's responders live: the shell's has none of them.
  releases.push(
    setCardContentForwarder((cardId, action) => {
      if (!bodyCardsStore.has(cardId)) return false;
      sendBus(connection, { card: cardId }, { kind: "card-command", payload: { command: "content-action", id: action } });
      return true;
    }),
    // An open of a file a body Text card already holds reveals the asked-for
    // line in that card, whose editor is in its own page.
    setBodyLineRevealer((cardId, line, endLine, columns) => {
      const payload: Record<string, unknown> = { line };
      if (endLine !== undefined) payload.endLine = endLine;
      if (columns !== undefined) payload.columns = [...columns];
      sendBus(connection, { card: cardId }, { kind: "card-command", payload: { command: "reveal-line", payload } });
    }),
  );

  return () => {
    for (const release of releases.splice(0)) release();
    for (const cardId of [...perCard.keys()]) forget(cardId);
  };
}
