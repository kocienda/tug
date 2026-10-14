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
 *   card stands as, activates the card, and closes it.
 * - The shell sends `deck-facts` to every body on change, and each card's
 *   `card-context` when its fold, arrival, first responder or layer changes,
 *   answering a card's first `card-facts` with both.
 * - `bodyFocus` goes to the host on every first-responder change, so the
 *   keyboard follows the deck's first responder into a body and out again.
 * - A destroyed card's body is destroyed with it, unsaved: its bag is about
 *   to be swept.
 * - A menu command bound for the key card goes to the key body when the key
 *   card is one and no shell surface holds the chain ahead of it.
 *
 * Laws: [L02] (the stores are read through `useSyncExternalStore`), [L22]
 * (advisors read the store directly), [L27] (every registration released).
 *
 * @module lib/body-shell
 */

import type { BusMasthead, CardAdvice, CardContext, CardFacts, DeckFacts } from "@tugproto/bus";
import type { TugConnection } from "../connection";
import type { IDeckManagerStore } from "../deck-manager-store";
import type { DeckState } from "../layout-tree";
import { getResponderChainManager } from "../action-registry";
import { dispatchCommand, setKeyCardForwarder } from "../command-dispatch";
import { setKeyboardYield } from "./keyboard-yield";
import { getOnScreenTheme, subscribeOnScreenTheme } from "../contexts/theme-provider";
import { cardArrivingOf, cardFoldedOf } from "../deck-store-selectors";
import { keyboardAccessStore } from "../keyboard-access-store";
import { projectDeckState } from "./host-menu-state";
import { focusTravelDirections } from "./directional-focus";
import { bodyCardsStore } from "./body-cards-store";
import { bodyCommandRoute, shellSurfaceAhead } from "./body-command-route";
import { bodyFactsStore } from "./body-facts-store";
import { bodyShown } from "./body-placement";
import { registerCardCloseAdvice } from "./card-close-advice";
import { registerCardFoldGuard } from "./card-fold";
import { cardSessionBindingStore } from "./card-session-binding-store";
import { cardTitleStore, type CardMastheadPayload } from "./card-title-store";
import { onBus, sendBus } from "./deck-bus";
import { replayBodyIntent } from "../body/body-intent";
import {
  bodyIntentOf,
  forgetBodyIntent,
  hostCapabilitiesStore,
  postToHost,
  suppressHandOff,
} from "./body-handoff";
import { openingBidForCard } from "./opening-bid";
import { pageZoomStore } from "./page-zoom-store";
import { sheetReservationMemberIdOf } from "./sheet-reservation";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

/** What the host reports about a body (`window.__tugBridge.onBodyState`). */
interface BodyStateReport {
  cardId?: unknown;
  state?: unknown;
  readyMs?: unknown;
  cause?: unknown;
}

function paneOf(state: DeckState, cardId: string): string | null {
  return state.panes.find((p) => p.cardIds.includes(cardId))?.id ?? null;
}

/** The `card-context` the shell owes `cardId`'s body now. */
export function cardContextFor(deck: IDeckManagerStore, cardId: string): CardContext {
  const state = deck.getSnapshot();
  const spaceId = deck.spaceOf(cardId);
  const activeSpaceId = deck.getSpacesSnapshot().activeSpaceId;
  return {
    folded: cardFoldedOf(state, cardId),
    arriving: cardArrivingOf(state, cardId),
    firstResponderCardId: deck.getFirstResponderCardId(),
    layerShown: spaceId === null || spaceId === activeSpaceId,
    spaceId,
  };
}

function readDeckFacts(deck: IDeckManagerStore): DeckFacts {
  const state = deck.getSnapshot();
  return {
    theme: getOnScreenTheme(),
    zoom: pageZoomStore.getFactor(),
    keyboardAccess: keyboardAccessStore.getMode() === "accessibility",
    modifierLatch: [],
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
  /** The member each card's sheet reservation was claimed under. */
  const reservedUnder = new Map<string, string>();

  const forget = (cardId: string): void => {
    perCard.get(cardId)?.();
    perCard.delete(cardId);
    heard.delete(cardId);
    sentContext.delete(cardId);
    hadMasthead.delete(cardId);
    reservedUnder.delete(cardId);
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
    const context = cardContextFor(deck, cardId);
    const json = JSON.stringify(context);
    if (!force && sentContext.get(cardId) === json) return;
    sentContext.set(cardId, json);
    sendBus(connection, { card: cardId }, { kind: "card-context", payload: context });
  };

  let focusedBody: string | null | undefined;
  const postFocus = (force: boolean): void => {
    const fr = deck.getFirstResponderCardId();
    const target = fr !== null && bodyCardsStore.has(fr) ? fr : null;
    if (!force && target === focusedBody) return;
    focusedBody = target;
    postToHost("bodyFocus", { cardId: target });
  };

  let lastFirstResponder = deck.getFirstResponderCardId();
  releases.push(
    deck.subscribe(() => {
      for (const cardId of heard) sendContext(cardId, false);
      publishDeckFacts();
      const fr = deck.getFirstResponderCardId();
      if (fr !== lastFirstResponder) {
        lastFirstResponder = fr;
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
  );

  // ---- What the bodies tell the shell ----

  releases.push(
    onBus(connection, "card-facts", (message) => {
      const cardId = message.from.cardId;
      if (cardId === null || !bodyCardsStore.has(cardId)) return;
      applyFacts(cardId, message.payload);
      if (!heard.has(cardId)) {
        heard.add(cardId);
        sendBus(connection, { card: cardId }, { kind: "deck-facts", payload: readDeckFacts(deck) });
        sendContext(cardId, true);
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
      case "close-request": {
        const paneId = paneOf(deck.getSnapshot(), cardId);
        if (paneId !== null) deck.removeCard(paneId, cardId);
        return;
      }
      case "dispatch":
        // The body's chain did not answer it; this one does, and never
        // forwards it back ([P04]: one front door, routed by the entry).
        dispatchCommand(advice.id, advice.payload, { local: true });
        return;
    }
  };

  // ---- What the host tells the shell ----

  const bridge = ((window as unknown as { __tugBridge?: Record<string, unknown> }).__tugBridge ??=
    {});
  bridge.onBodyState = (report: BodyStateReport): void => {
    const cardId = typeof report?.cardId === "string" ? report.cardId : null;
    if (cardId === null || !bodyCardsStore.has(cardId)) return;
    switch (report.state) {
      case "ready":
        bodyCardsStore.setState(cardId, "ready");
        // The body exists now; if its card holds the keyboard, it takes it.
        if (deck.getFirstResponderCardId() === cardId) postFocus(true);
        return;
      case "painted":
        // Its first frame of content is composited: the placer may show it.
        bodyCardsStore.setState(cardId, "painted");
        return;
      case "shown":
        // The host's container is placed, opaque and drawn: the lid lifts.
        bodyShown(cardId);
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
        if (intent !== null && cardSessionBindingStore.getBinding(cardId) === undefined) {
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
        const fr = deck.getFirstResponderCardId();
        return fr !== null && bodyCardsStore.has(fr) && !shellAheadNow();
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
      const fr = deck.getFirstResponderCardId();
      if (fr !== null && bodyCardsStore.has(fr) && !shellAheadNow()) postFocus(true);
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

  return () => {
    for (const release of releases.splice(0)) release();
    for (const cardId of [...perCard.keys()]) forget(cardId);
  };
}
