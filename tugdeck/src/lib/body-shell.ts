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
import { requestLogout } from "./logout-store";
import { ShellSurfaceDrawer } from "./shell-surface";
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

  const forget = (cardId: string): void => {
    perCard.get(cardId)?.();
    perCard.delete(cardId);
    heard.delete(cardId);
    sentContext.delete(cardId);
    hadMasthead.delete(cardId);
    reservedUnder.delete(cardId);
    surfaces.remove(cardId);
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
    releases.push(manager.subscribe(() => postFocus(false)));
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
        // Its first frame of content is composited: the placer may show it.
        bodyCardsStore.setState(cardId, "painted");
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
        surfaces.remove(cardId);
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

  return () => {
    for (const release of releases.splice(0)) release();
    for (const cardId of [...perCard.keys()]) forget(cardId);
  };
}
