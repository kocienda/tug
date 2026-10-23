/**
 * A card's body page: one card, in a web view of its own, on a connection of
 * its own, bridged to the shell.
 *
 * A body boots one of two ways and is bound one way. A cold body loads
 * `/?body=<cardId>` and its hello names its card; the warm spare loads
 * `/?body=spare` and its hello names `spare:<pageId>`. Either connects, waits
 * for the tugbank snapshot and the markdown WASM as the shell does, registers
 * every card kind the shell registers (`card-kinds.ts`), `eval` and the
 * session acks, and posts `bodyHello`. The host answers with
 * `onBodyBind({cardId, componentId, intent, facts})`; a spare first takes its
 * card from tugcast with `page_bind`. Then the page builds the card's own
 * deck (`body-card-deck.ts`), mounts the card of that kind with one
 * `root.render()` ([L01]),
 * replays the intent, and posts `frontendReady` one paint after the card's
 * session goes quiet, or at the arrival bound, whichever comes first — or
 * one paint after mount, for a kind with no session (a `mount` intent).
 *
 * Two channels, and no third. What passes between this page and the host —
 * the bind, the crossing a resize announces (`onBodyCrossing`), the body
 * messages `postToHost` sends — is host plumbing. Everything between this
 * page and the shell goes over the page bus (`bus/`): the card's own stores
 * are owned here and replicated there, the deck's are read here as replicas,
 * the shell's verbs and requests are answered by `body-verbs.ts`, and what
 * this page asks of the shell is a declared action (`bus/declarations/`).
 *
 * Nothing here imports `main.tsx`: `entry.ts` loads this module instead of
 * the deck's, so no deck is ever constructed in a body.
 *
 * @module body/body-main
 */

import "../css-imports";
import "../components/tugways/tug-markdown-view.css";
import "./body-page.css";

import { createRoot } from "react-dom/client";
import initTugmark from "../../crates/tugmark-wasm/pkg/tugmark_wasm.js";
import wasmUrl from "../../crates/tugmark-wasm/pkg/tugmark_wasm_bg.wasm?url";
import { TugConnection } from "../connection";
import { FeedId } from "../protocol";
import { installDomForensics } from "../lib/dom-forensics";
import { installGestureScope, NEVER_HELD } from "../lib/gesture-scope";
import { setConnection } from "../lib/connection-singleton";
import { TugbankClient } from "../lib/tugbank-client";
import { setTugbankClient } from "../lib/tugbank-singleton";
import { ConnectionLifecycle, registerConnectionLifecycle } from "../lib/connection-lifecycle";
import { registerCardDeck, registerDeckView } from "../lib/deck-store-registry";
import { registerCardLifecycle } from "../lib/card-lifecycle";
import { AppLifecycle, registerAppLifecycle } from "../lib/app-lifecycle";
import { SheetLifecycle, registerSheetLifecycle } from "../lib/sheet-lifecycle";
import { BannerLifecycle, registerBannerLifecycle } from "../lib/banner-lifecycle";
import { installLifecycleCascade } from "../lib/lifecycle-cascade";
import {
  cycleFocusMode,
  dispatchAction,
  registerAction,
  registerAppLifecycleAction,
  registerEvalAction,
  registerRunCardCommand,
  registerStoreTailActions,
} from "../action-dispatch";
import { TUG_ACTIONS } from "../lib/action-vocabulary";
import { bodyCardFilter, registerSessionControlActions } from "../lib/session-control-actions";
import { cardSessionBindingStore, shareCardBinding } from "../lib/card-session-binding-store";
import { shareArcPresses } from "../lib/arc-press-store";
import { cardServicesStore } from "../lib/card-services-store";
import { attachSessionLedgerStore } from "../lib/session-ledger-store";
import { attachSessionStateChangesStore } from "../lib/session-state-changes-store";
import { attachDigestStore } from "../lib/digest-store";
import { attachOverviewStore } from "../lib/overview-store";
import { attachSessionActivityStore } from "../lib/session-activity-store";
import { attachChangesetAllStore, getChangesetAllStore } from "../lib/changeset-all-store";
import { attachChangesetVerbStore } from "../lib/changeset-verb-store";
import { attachChangesetDraftStore } from "../lib/changeset-draft-store";
import { attachChangesetJoinStore } from "../lib/changeset-join-store";
import { applyHostToolsOfferResultPayload, applyHostToolsResultPayload } from "../lib/host-tools-store";
import { reassertOnReconnect, restorePassGate, sessionRestoreRegistry } from "../lib/session-restore";
import { interruptLiveSessions, type TerminationVerdict } from "../teardown";
import {
  putCardState,
  readCardStates,
  readKeyboardAccess,
} from "../settings-api";
import { keyboardAccessStore, normalizeKeyboardAccessMode } from "../keyboard-access-store";
import { KEYMAP_DOMAIN, keymapOverrideStore } from "../keymap-override-store";
import { focusRingModalityStore, normalizeFocusRingModality } from "../focus-ring-modality-store";
import { applyShellModifierLatch } from "../components/tugways/modifier-latch";
import { applyTheme, followShellTheme, getOnScreenTheme } from "../contexts/theme-provider";
import { pageZoomStore } from "../lib/page-zoom-store";
import { initMotionObserver } from "../lib/scale-timing";
import { installMotionGuard } from "../lib/motion-guard";
import { motionBreaker } from "../lib/motion-guard/breaker";
import { applyShellMenuFacts, initBodyHostMenuState } from "../lib/host-menu-state";
import { scheduleAfterPaint } from "../lib/after-paint";
import { advanceKeyViewFocus, getFocusManager } from "../components/tugways/focus-manager";
import { installDictationBridge } from "../lib/dictation-bridge";
import { ARRIVAL_REVEAL_BOUND_MS, type ArrivalQuiet } from "../lib/arrival-reveal";
import { sessionPickerQuiet } from "../components/tugways/cards/session-picker-quiet";
import { bindPageCard, installPage, page } from "../bus/page";
import { createPageBus, installPageBus, pageBus } from "../bus/page-bus";
import { connectionTransport } from "../bus/transport";
import type { SharedStore } from "../bus/shared-store";
import {
  deckCards,
  deckFacts,
  deckFrontmostProject,
  deckMenu,
  harnessBodyDelays,
  type DeckFactsValue,
} from "../bus/declarations/deck";
import {
  cardContext,
  cardCrossing,
  cardInspected,
  cardPainted,
  cardReservations,
  devtoolsInspection,
} from "../bus/declarations/card";
import { followMiniatureGauges } from "../lib/miniature-bus";
import { reauthenticate } from "../lib/reauthenticate";
import { answerPageCall, installHostChannel, onHostMessage, postToHost, tugdeckPageCalls } from "../host/channel";
import {
  bodyHelloToHost,
  bodySurfaceToHost,
  crossingReadyToHost,
  crossingSolvedToHost,
  frontendReadyToHost,
  bodyBindToPage,
  bodyVisibilityToPage,
  paintedToHost,
  type BodyBind,
  prepareForTerminationCall,
  reauthenticateCall,
  saveStateCall,
} from "../host/declarations/lifecycle";
import { bodyCrossingToPage } from "../host/declarations/geometry";
import { UsageStore } from "../lib/usage-store";
import { beginResizeEpisode, type ResizeEpisodeHandle } from "../lib/resize-episode";
import { landRecorder } from "../lib/land-frame-record";
import { CARD_FOLD_ATTR } from "../lib/folded-body";
import { runCrossingSolve } from "./crossing-solve";
import { readCrossingAnchor, readCrossingBand } from "../lib/crossing-band";
import { deckTrace } from "../deck-trace";
import { createBodyLand } from "./body-land";
import { loadMakerTooling, registerCardKinds } from "../card-kinds";
import { tugDevLogStore } from "../lib/tug-dev-log-store/tug-dev-log-store";
import { exposePerfMonitor, startPerfMonitor } from "../lib/perf-monitor";
import { getSettings } from "../lib/maker-mode-bridge";
import { getRegistration, isSidebarCard } from "../card-registry";
import { cardActivityElsewhere } from "../lib/card-activity-elsewhere";
import { cardIdentityElsewhere } from "../lib/card-identity";
import { cardTitleStore } from "../lib/card-title-store";
import { movedFacets } from "../lib/deck-cards";
import { appInfoStore } from "../lib/app-info-store";
import { relayFrontmostProjectBinding, relayWorkspaceProjectDirs } from "../lib/frontmost-project";
import { bodyVisibilityStore } from "../lib/body-visibility-store";
import { withholdBodySurface } from "../lib/surface-mirror";
import { BODY_DORMANT_ATTRIBUTE, installBodyDormancy, sessionAnswersCatchUp } from "./body-dormancy";
import { DORMANT_AFTER_MS } from "../lib/body-visibility-store";
import { applyCrossingMirror } from "../lib/fold-crossing";
import { telemetryInspectionStore } from "../lib/telemetry-inspection-store";
import { installInspectionPublisher } from "./body-inspection";
import { cardsSpaceVerbRequest } from "../components/cards/cards-space-verb-request";
import { shareLayoutSelection } from "../lib/cards-selection-store";
import {
  appInfo,
  arrangementDeck,
  arrangementSpaces,
  cardFollowed,
  cardsLedgerBindings,
  cardsSpaceVerb,
} from "../bus/declarations/arrangement";
import { spaceBindingsLedgerStore } from "../lib/space-bindings-ledger-store";
import { CARDS_CARD_ID } from "../lib/cards-card-id";
import { OVERVIEW_CARD_ID } from "../lib/overview-card-id";
import { retellOverviewDraft } from "../lib/overview-composer-draft";
import { ARCS_CARD_ID } from "../lib/arcs-card-id";
import { installHmrLanded } from "../lib/hmr-landed";
import { installScopedReload } from "../lib/scoped-reload";
import { createBodyCardDeck, createDeckView, type BodyCardDeck } from "./body-card-deck";
import { renderBodyRoot } from "./body-root";
import { installBodyPublisher, type InstalledBodyPublisher } from "./body-publisher";
import { parseBodyIntent, replayBodyIntent, type BodyIntent } from "./body-intent";
import { answerBodyVerbs } from "./body-verbs";

/**
 * The kinds that list other cards' sessions — the Cards card's rows, the
 * Overview's posts, the Arcs card's workers — and so are shown every ledger
 * row push and the whole bindings list (`bodyCardFilter`'s `lists`).
 */
const LISTS_SESSIONS: ReadonlySet<string> = new Set([CARDS_CARD_ID, OVERVIEW_CARD_ID, ARCS_CARD_ID]);

/**
 * The page's own surface as sRGB bytes `[r, g, b, a]`, a = 0–255: the
 * background of the first box that paints one — the card's root, then
 * `body`, then `html`, which computes transparent here — drawn into a
 * one-pixel canvas, so whatever colour space a theme token resolves in,
 * the host reads plain bytes.
 */
function pageSurfaceRgba(): number[] | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const g = canvas.getContext("2d");
  if (g === null) return null;
  for (const el of [document.getElementById("deck-container"), document.body, document.documentElement]) {
    if (el === null) continue;
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = getComputedStyle(el).backgroundColor;
    g.fillRect(0, 0, 1, 1);
    const rgba = [...g.getImageData(0, 0, 1, 1).data];
    if (rgba[3] > 0) return rgba;
  }
  return null;
}

/**
 * Tell the host the page's surface, for the container to wear behind the
 * web view, which draws no background of its own: a sliver of the view the
 * layout viewport does not reach reads the pane's colour, not white.
 */
function postSurface(): void {
  postToHost(bodySurfaceToHost, { surface: pageSurfaceRgba() });
}

installDomForensics();
installGestureScope(window);
followShellTheme();
// Receive the host's dictation events here too: the host answers the view
// that sent the `start`, and a body whose composer claimed the mic is that
// view. Without the receiver a body's start was answered into nothing and
// its button stood at "starting" (row 5's reading). The host's members go in
// first, so every receiver below has its member to arrive through.
installHostChannel();
installDictationBridge();
// Each update Vite applies in this page, timed to the host's log.
if (import.meta.hot) installHmrLanded(import.meta.hot);
// A reload Vite scopes to the bodies; the host saves the card's state first.
if (import.meta.hot) installScopedReload(import.meta.hot, "body");
document.documentElement.setAttribute("data-body-page", "");

const named = new URLSearchParams(window.location.search).get("body");
const isSpare = named === "spare";
// A cold body knows its card from its address; the spare learns it at bind.
installPage({ role: "body", cardId: isSpare ? null : named, componentId: null });
const connection = new TugConnection(`ws://${window.location.host}/ws`, {
  host: "worker",
  page: { role: "body", cardId: isSpare ? null : named },
  // A body streams through the shell's settles: its frames are its own.
  motionGate: NEVER_HELD,
});
const connectionLifecycle = new ConnectionLifecycle();
connection.setLifecycle(connectionLifecycle);
registerConnectionLifecycle(connectionLifecycle);
setConnection(connection);
// The page's one `DECK_BUS` listener, up before anything that crosses: a
// deck store the shell broadcasts may reach a page not yet bound.
installPageBus(createPageBus(connectionTransport(connection, connectionLifecycle), page));
const tugbankClient = new TugbankClient(connection);
setTugbankClient(tugbankClient);

const isTestMode = window.__tugTestMode === true;

// The shell's dev handles, in this page too: a test reads a card's log and its
// perf census in the page that draws the card, as the shell's own are read in
// the shell's (`main.tsx`). Dev and test builds only, for the same reason.
if (import.meta.env.DEV || isTestMode) {
  (window as unknown as { tugDevLog?: typeof tugDevLogStore }).tugDevLog = tugDevLogStore;
  startPerfMonitor();
  exposePerfMonitor();
}

/** Durable card-state writes, held back in test mode as the deck holds its own. */
function putCardStateGuarded(
  cardId: string,
  bag: Parameters<typeof putCardState>[1],
  options?: Parameters<typeof putCardState>[2],
): Promise<boolean> {
  if (isTestMode && window.__tugPersistInTestMode !== true) return Promise.resolve(true);
  return putCardState(cardId, bag, options);
}

/**
 * Tell this page's stores when another card's facts moved in `deck.cards`.
 * They read other cards' entries from the replica themselves
 * (`lib/deck-cards.ts`), so nothing is copied: this only wakes the readers
 * of the store whose facts moved.
 */
function followDeckCards(cardId: string): void {
  let before = deckCards.getSnapshot();
  deckCards.subscribe(() => {
    const next = deckCards.getSnapshot();
    const moved = movedFacets(before, next, cardId);
    before = next;
    if (moved.has("binding")) cardSessionBindingStore.notify();
    if (moved.has("title")) cardTitleStore.notify();
    if (moved.has("identity")) cardIdentityElsewhere.notify();
    if (moved.has("activity")) cardActivityElsewhere.notify();
  });
}

/**
 * The arc this card's session is mated to follows the shell's. A bind is one
 * fact whichever door it came through, and the doors that name no card
 * (`tugtool arc bind`, `arc create`'s auto-bind) are answered by the shell,
 * which maps a session to its card across every card it holds. So the own
 * card's arc is applied when the shell's moves, which leaves a bind this page
 * heard first standing until the shell agrees.
 */
function followOwnArcBinding(cardId: string): void {
  let arcBefore: string | undefined;
  const apply = (): void => {
    const binding = deckCards.getSnapshot()[cardId]?.binding ?? null;
    if (binding === null) return;
    const arc = JSON.stringify(binding.arc ?? null);
    if (arc !== arcBefore) cardSessionBindingStore.setArcBinding(cardId, binding.arc ?? null);
    arcBefore = arc;
  };
  deckCards.subscribe(apply);
  apply();
}

/**
 * Call `apply` with `store`'s value whenever it changes, and now if it has
 * already arrived: a deck store the shell broadcast reaches this page before
 * its card is bound.
 */
function follow<T>(store: SharedStore<T>, apply: (value: T) => void): void {
  store.subscribe(() => apply(store.getSnapshot()));
  if (store.arrived()) apply(store.getSnapshot());
}

/**
 * The motion switch's two writers in a body: the shell's hand switch,
 * followed from its deck facts, and the body's own dormancy, which stills its
 * loops while it is hidden past its delay. Either stills them.
 */
let shellMotionDemoted = false;
let dormantLoopsStilled = false;
function applyMotion(): void {
  motionBreaker.demote(shellMotionDemoted || dormantLoopsStilled);
}

/**
 * Ask `cardId`'s session for what a dormant body missed, and call `done` when
 * the bracket that answers has closed: the store's `catchingUp` rises when
 * the ask is recorded and falls when the bracket closes, or at the store's
 * own deadline when none comes, which is the one horizon. A card with no
 * session, or whose session the ledger shows closed or failed, has nothing to
 * catch up on. A store disposed mid-wait clears its listeners, so the wait
 * also follows the card's services and ends when the store it asked is no
 * longer the card's. Returns the release for the wait.
 */
function catchUpCard(cardId: string, done: () => void): () => void {
  const store = cardServicesStore.getServices(cardId)?.codeSessionStore ?? null;
  if (store === null || !sessionAnswersCatchUp(deckCards.getSnapshot()[cardId]?.sessionState)) {
    // Nothing will answer: the deadlines the sleep stopped start from now.
    store?.noteAwake();
    done();
    return () => {};
  }
  let rose = false;
  let finished = false;
  const releases: Array<() => void> = [];
  const release = (): void => {
    finished = true;
    for (const r of releases.splice(0)) r();
  };
  const finish = (): void => {
    if (finished) return;
    release();
    done();
  };
  releases.push(
    store.subscribe(() => {
      const catchingUp = store.getSnapshot().catchingUp;
      if (catchingUp) rose = true;
      else if (rose) finish();
    }),
    cardServicesStore.subscribe(() => {
      if (cardServicesStore.getServices(cardId)?.codeSessionStore !== store) finish();
    }),
  );
  store.catchUp();
  return release;
}

/** Take the shell's deck facts this page renders against. */
function applyDeckFacts(facts: Partial<DeckFactsValue>, deck: BodyCardDeck | null): Promise<void> {
  if (typeof facts.keyboardAccess === "boolean") {
    keyboardAccessStore.setMode(facts.keyboardAccess ? "accessibility" : "standard", { persist: false });
  }
  // Facts, followed and never persisted: the shell's modality, and the
  // modifiers the shell's key events say are held.
  if (typeof facts.focusRingModality === "string") {
    focusRingModalityStore.setMode(normalizeFocusRingModality(facts.focusRingModality), { persist: false });
  }
  if (Array.isArray(facts.modifierLatch)) applyShellModifierLatch(facts.modifierLatch);
  if (typeof facts.appActive === "boolean") deck?.setHasFocus(facts.appActive);
  // The shell's hand switch, followed: the body's own root attribute stills
  // its loops, and clearing it resumes them through the body's breaker.
  if (typeof facts.motionDemoted === "boolean") {
    shellMotionDemoted = facts.motionDemoted;
    applyMotion();
  }
  if (typeof facts.zoom === "number") {
    if (deck === null) pageZoomStore.report(facts.zoom);
    else void pageZoomStore.apply(facts.zoom);
  }
  if (typeof facts.theme === "string" && facts.theme !== getOnScreenTheme()) {
    return applyTheme(facts.theme).then(postSurface);
  }
  return Promise.resolve();
}

/** A spare takes its card from tugcast; resolves whether it did. */
function bindSpare(cardId: string): Promise<boolean> {
  return new Promise((resolve) => {
    registerAction("page_bound", () => resolve(true));
    registerAction("page_bind_refused", (payload) => {
      tugDevLogStore.error("body", "page_bind refused", { cardId, detail: payload.detail });
      resolve(false);
    });
    connection.sendControlFrame("page_bind", { card_id: cardId });
  });
}

/**
 * Post `frontendReady` one paint after the card's session is quiet — out of
 * restoring and replaying — or once the arrival bound has passed since mount,
 * whichever is first; a card with no session (`mounting`) is quiet at mount
 * and an unbound one is quiet when its picker is ([L05]: the paint is waited
 * on with `scheduleAfterPaint`
 * from the quiet's own notify; its deadline covers a page whose frames are
 * suspended). The layer turns shown just before, so the card's deferred
 * restore lands while the container is still hidden.
 *
 * An unbound card is its picker: the restore pass found no binding for it and
 * none is in flight, the test the card's own render makes before it falls
 * through to the picker. It has no session that will ever leave restoring,
 * so it is quiet when the picker's content is — the rule the shell waits on
 * for a picker it draws itself (`sessionPickerQuiet`). Waiting on the session
 * instead held every ⌘N's reveal to the bound: the shell reveals the card on
 * this page's ready.
 *
 * Then `painted`: the layer's showing re-renders the recede, and the frame
 * that carries it is handed to the compositor before the SECOND
 * `requestAnimationFrame` after it runs — a frame callback runs before its
 * frame's rendering update, so the first rAF precedes that frame and the
 * second follows its commit. `ready` is the card mounted and quiet; `painted`
 * is the first frame of its real content gone to the compositor, and it is
 * what the host shows the container on.
 *
 * `painted` is said twice: to the host, which composites the frame, and on
 * the bus to the shell (`card.painted`), set after a publish of the facts the
 * frame was drawn with, so the store goes behind them. The shell draws the
 * card's chrome from those facts — a Session card's masthead grows its title
 * bar by 52 pt — so it shows the body only once it has heard both: the
 * host's word alone can outrun the facts and place the body under chrome
 * that is about to move it (`at0738-body-arrival`).
 */
function signalReadyWhenQuiet(
  cardId: string,
  deck: BodyCardDeck,
  publisher: InstalledBodyPublisher,
  mounting: boolean,
  onMounted: () => void,
): void {
  let done = false;
  const releases: Array<() => void> = [];
  const ready = (): void => {
    if (done) return;
    done = true;
    for (const release of releases) release();
    scheduleAfterPaint(() => {
      onMounted();
      deck.revealLayer();
      postToHost(frontendReadyToHost, {});
      postSurface();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          postToHost(paintedToHost, {});
          publisher.painted();
          cardPainted.set(true);
        });
      });
    });
  };
  let picker: ArrivalQuiet | null | undefined;
  const showsPicker = (): boolean =>
    cardServicesStore.getServices(cardId) === null &&
    restorePassGate.getSnapshot() &&
    !sessionRestoreRegistry.has(cardId);
  const quiet = (): boolean => {
    if (mounting) return true;
    if (showsPicker()) {
      if (picker === undefined) {
        picker = sessionPickerQuiet();
        if (picker !== null) releases.push(picker.subscribe(follow));
      }
      return picker?.isQuiet() ?? true;
    }
    const snapshot = cardServicesStore.getServices(cardId)?.codeSessionStore.getSnapshot();
    return (
      snapshot !== undefined &&
      snapshot.transportState !== "restoring" &&
      snapshot.phase !== "replaying"
    );
  };
  let releaseSession: (() => void) | null = null;
  const follow = (): void => {
    if (quiet()) {
      ready();
      return;
    }
    releaseSession?.();
    releaseSession =
      cardServicesStore.getServices(cardId)?.codeSessionStore.subscribe(() => {
        if (quiet()) ready();
      }) ?? null;
  };
  releases.push(
    cardServicesStore.subscribe(follow),
    restorePassGate.subscribe(follow),
    sessionRestoreRegistry.subscribe(follow),
    () => releaseSession?.(),
  );
  const bound = window.setTimeout(ready, ARRIVAL_REVEAL_BOUND_MS);
  releases.push(() => window.clearTimeout(bound));
  follow();
}

/** Bind this page to `cardId` and bring the card up. */
async function bindBody(bind: BodyBind): Promise<void> {
  const { cardId } = bind;
  // The host always names the kind; a bind that does not is refused here,
  // and the body's ready deadline hands the card back to the shell.
  if (bind.componentId.length === 0) {
    tugDevLogStore.error("body", "onBodyBind named no componentId; not binding", { cardId });
    return;
  }
  const componentId = bind.componentId;
  if (isSpare && !(await bindSpare(cardId))) return;
  bindPageCard(cardId, componentId);
  const intent: BodyIntent = parseBodyIntent(bind.intent) ?? { kind: "restore" };

  const restoreBag = !isTestMode || window.__tugRestoreInTestMode === true;
  const registration = getRegistration(componentId);
  const deck = createBodyCardDeck({
    cardId,
    componentId,
    reserve: (reservations) => cardReservations.set(reservations),
    putCardState: putCardStateGuarded,
    // The bag the shell handed over is the freshest there is; without one,
    // the body reads what was last written.
    initialBag:
      intent.bag !== undefined
        ? intent.bag
        : restoreBag
          ? readCardStates(tugbankClient, [cardId]).get(cardId)
          : undefined,
  });
  registerCardDeck(deck);
  registerCardLifecycle(deck.cardLifecycle);
  // A body whose card is not the key card focuses nothing, a press places
  // the engine for this page's card, and a Tab off either end of the walk
  // goes to the shell: each reads the page (`keyboard-yield.ts`,
  // `gesture-interpreter.ts`, `focus-walk-edge.ts`).
  //
  // The View menu's two doors onto the walk, which the shell hands here
  // while the card's stops are this page's (their rows' owner is the key card).
  registerAction(TUG_ACTIONS.NEXT_KEYBOARD_FOCUS, () => {
    advanceKeyViewFocus(getFocusManager(), 1);
  });
  registerAction(TUG_ACTIONS.PREVIOUS_KEYBOARD_FOCUS, () => {
    advanceKeyViewFocus(getFocusManager(), -1);
  });
  // ⌥⇥ toggles the card's own cycle, so it is answered here, where the
  // card's responders and stops are.
  registerAction(TUG_ACTIONS.CYCLE_FOCUS_MODE, cycleFocusMode);
  // What the card raises past its own content box — the Z2 placard — the
  // overlay draws (`getSurfaceHost`), and a logout is the app's, which only
  // the shell mounts (`requestLogout` sends it `app.logout`).
  const appLifecycle = new AppLifecycle();
  registerAppLifecycle(appLifecycle);
  // The host's app-lifecycle frames reach every page on CONTROL; this page's
  // lifecycle hears them only if it answers the action, and a mic claimed
  // here must end when the app resigns.
  registerAppLifecycleAction();
  const sheetLifecycle = new SheetLifecycle();
  registerSheetLifecycle(sheetLifecycle);
  const bannerLifecycle = new BannerLifecycle();
  registerBannerLifecycle(bannerLifecycle);
  installLifecycleCascade(deck.cardLifecycle, appLifecycle);

  // The session acks this card holds, and no other card's. The card's
  // sessions are read fresh per ack, so a rebind is admitted at once.
  registerSessionControlActions(
    bodyCardFilter(() => {
      const binding = cardSessionBindingStore.getBinding(cardId);
      const sessions = binding === undefined
        ? intent.kind === "restore" || intent.kind === "mount" ? [] : [intent.tugSessionId]
        : [binding.tugSessionId, ...(binding.seatedSessionId === undefined ? [] : [binding.seatedSessionId])];
      return { cardId, sessionIds: sessions, lineId: binding?.lineId ?? null };
    }, { lists: LISTS_SESSIONS.has(componentId) }),
  );
  // A card that lists every card's session reads the bindings cache, which
  // only a restore pass installs, and no restore pass runs here.
  if (LISTS_SESSIONS.has(componentId)) spaceBindingsLedgerStore.installOnce();
  cardServicesStore.attachBody(cardId);
  // What this page's chain does not answer — a chord its funnel matched for
  // the deck, a close the pane handles, a control's action sent to a parent
  // that is the deck's — is the shell's, which runs it in its own chain,
  // where the pane and the deck stand (`forwardToShell` and
  // `forwardUnansweredTarget`, `bus/command-route.ts`, which say what is
  // declined and what is sent unclaimed).
  //
  // A menu's `run-card-command`, which the shell sends this card when it is
  // the key card: run here, where its surface map is.
  registerRunCardCommand();
  // The card's binding is the shell's too: each change of it is proposed.
  shareCardBinding();
  // So are the arc transport presses: this card's Start, Resume and Stop are
  // proposed to the shell, which sends them and hears their answers, and a
  // refusal spoken here may have been pressed on another card's page.
  shareArcPresses();
  // The session set follows the card's binding: a rotation seats a new
  // segment. The store also reads every other card's binding, from the
  // shell's `deck.cards`, so only a change to this card's own sessions re-scopes the
  // connection: a re-scope is a message to the worker, not a no-op. A body
  // asleep — dormant, hidden past its delay — is scoped to nothing.
  let scopedSessions = "";
  let dormancy: { readonly asleep: boolean } | null = null;
  const rescope = (): void => {
    const binding = cardSessionBindingStore.getBinding(cardId);
    if (binding === undefined) return;
    const sessions = dormancy?.asleep
      ? []
      : binding.seatedSessionId === undefined
        ? [binding.tugSessionId]
        : [binding.tugSessionId, binding.seatedSessionId];
    const key = sessions.join(" ");
    if (key === scopedSessions) return;
    scopedSessions = key;
    connection.setSessions(sessions);
  };
  cardSessionBindingStore.subscribe(rescope);
  // Hidden past its delay, the body sleeps: no subscription, its loops
  // still, its deck-scope surface withdrawn, its bag written once. Shown again, it re-scopes and
  // asks its session for what it missed, and wakes when that has landed.
  dormancy = installBodyDormancy({
    rescope,
    stillLoops: (on) => {
      dormantLoopsStilled = on;
      applyMotion();
    },
    lidContent: (on) => document.documentElement.toggleAttribute(BODY_DORMANT_ATTRIBUTE, on),
    withholdSurface: withholdBodySurface,
    saveBag: () => void deck.saveNow(),
    sleepSession: () => cardServicesStore.getServices(cardId)?.codeSessionStore?.noteDormant(),
    catchUp: (done) => catchUpCard(cardId, done),
  });

  // The host's bind facts stand until the shell's arrive: they are what the
  // card's first paint is drawn against.
  await applyDeckFacts(bind.facts, null);
  follow(deckFacts, (facts) => void applyDeckFacts(facts, deck));
  follow(deckMenu, (menu) => {
    if (menu !== null) applyShellMenuFacts(menu);
  });
  follow(deckFrontmostProject, ({ binding, projectDirs }) => {
    relayFrontmostProjectBinding(binding);
    relayWorkspaceProjectDirs(projectDirs);
  });
  // The crossing the shell's pane stands under, held here on this page's
  // own frame so the card root holds through it as an in-document one does.
  follow(cardCrossing, (crossing) => {
    const frame = document.querySelector<HTMLElement>(".body-pane-frame");
    if (frame !== null) applyCrossingMirror(frame, crossing);
  });
  // Other cards' bindings, titles, identities and phases: this page's stores
  // read them from `deck.cards`, and the own card's arc follows the shell's.
  followDeckCards(cardId);
  followOwnArcBinding(cardId);
  follow(cardContext, (context) => deck.applyContext(context));
  // A card that lists or moves the whole deck reads the shell's.
  const view =
    registration?.bodyDeck === "arrangement"
      ? createDeckView(deck, { deck: arrangementDeck, spaces: arrangementSpaces })
      : null;
  if (view !== null) registerDeckView(view);
  // The card a following card follows, which only the shell's focus manager knows.
  if (registration?.bodyFollows === true) follow(cardFollowed, (followed) => deck.applyFollowed(followed?.cardId ?? null));
  // The app's identity the host sent the shell, for the About card.
  follow(appInfo, (info) => {
    if (info !== null) appInfoStore.set(info);
  });
  // The Overview's draft is held by the shell, which a reload empties.
  if (componentId === OVERVIEW_CARD_ID) retellOverviewDraft();
  if (componentId === CARDS_CARD_ID) {
    // The Cards list's selection and cursor are the shell's, whose deck verbs
    // read them: the list proposes each change it makes.
    shareLayoutSelection();
    // The shell's bindings cache, which enters here at the action the
    // server's own frame enters at, so its rows seed what the frame's rows
    // seed.
    follow(cardsLedgerBindings, (bindings) => {
      if (bindings !== null) dispatchAction({ action: "list_card_bindings_ok", bindings });
    });
    // A workspace verb the shell's menu asked this card to answer: put it in
    // this page's slot, where the card reads it.
    cardsSpaceVerb.handle(({ verb, spaceId }) => cardsSpaceVerbRequest.request(verb, spaceId));
  }
  // The inspection this card publishes for a devtools card that follows it,
  // while the shell says one does.
  let releaseInspection: (() => void) | null = null;
  follow(cardInspected, (inspected) => {
    if (inspected === (releaseInspection !== null)) return;
    releaseInspection?.();
    releaseInspection = inspected ? installInspectionPublisher(cardId) : null;
  });
  // The followed card's inspection, relayed to this devtools card.
  follow(devtoolsInspection, (inspection) => telemetryInspectionStore.relay(inspection));
  // An arrangement card's miniature draws the shell's gauges and drags on the
  // shell's canvas (`miniature-bus.ts`); its drags find the shell's canvas
  // through `getMiniatureDropHost`.
  if (registration?.bodyDeck === "arrangement") followMiniatureGauges();
  // The verbs and questions the shell asks of this card (`body-verbs.ts`).
  let markMounted = (): void => {};
  const mounted = new Promise<void>((resolve) => {
    markMounted = resolve;
  });
  answerBodyVerbs(pageBus(), {
    cardId,
    componentId,
    replayIntent: (forwarded) => replayBodyIntent(forwarded, cardId, connection, deck),
    mounted,
  });

  initBodyHostMenuState(deck, view);
  // The `/usage` panel is account-global, and a Session card's sheet reads it
  // from its own page, which asks tugcast on its own connection.
  const usageStore = new UsageStore(connection);
  if (isTestMode) {
    const surface = await import("../test-surface");
    surface.attachBodyTestSurface(deck, { usageStore });
  }

  // Every listener this page answers on is up: say hello. The shell answers
  // with every store this card reads, then whatever it held for it.
  pageBus().announce();

  createRoot(document.getElementById("deck-container") ?? document.body).render(
    renderBodyRoot({
      deck,
      view,
      componentId,
      appLifecycle,
      sheetLifecycle,
      bannerLifecycle,
      usageStore,
    }),
  );
  deck.cardLifecycle.notifyCardDidFinishConstruction(cardId);
  const publisher = installBodyPublisher(cardId, {
    // A rail card's content height, for the shell's Resize Sidebars to Fit.
    watchContent: isSidebarCard(componentId),
  });

  replayBodyIntent(intent, cardId, connection, deck);

  // After a reconnect this page re-asserts its card exactly as the shell
  // re-asserts its own: a spare that took its card takes it again, and the
  // card is re-bound (the same tugcast) or restored from the ledger (a
  // restarted one).
  connectionLifecycle.observeConnectionDidReconnect(() => {
    if (isSpare) {
      // The hello this page said on the open went out as the spare, before
      // it took its card again; say it as the card.
      connection.sendControlFrame("page_bind", { card_id: cardId });
      pageBus().announce();
    }
    reassertOnReconnect(deck, connection);
  });

  answerPageCall(saveStateCall, () => {
    void deck.saveNow({ sync: true });
    return null;
  });
  answerPageCall(
    prepareForTerminationCall,
    async (): Promise<TerminationVerdict> => {
      const started = performance.now();
      const { interrupted, unacknowledged } = await interruptLiveSessions();
      const saved = await deck.saveNow();
      return {
        ok: saved && unacknowledged.length === 0,
        interrupted,
        unacknowledged,
        flushedCards: 1,
        failedCards: saved ? [] : [cardId],
        layoutSaved: true,
        elapsedMs: performance.now() - started,
      };
    },
  );
  answerPageCall(reauthenticateCall, (payload) => reauthenticate(payload, connection));
  window.tugdeck = {
    ...tugdeckPageCalls(),
    diag: {
      // Whether this card is publishing its inspection for a devtools card.
      inspecting: () => releaseInspection !== null,
    },
  } as unknown as typeof window.tugdeck;

  signalReadyWhenQuiet(cardId, deck, publisher, intent.kind === "mount", markMounted);
}

(async () => {
  // The connection-scoped stores the session card reads, attached as the
  // shell attaches them (`main.tsx`): the ledger behind the picker, the
  // Z2 state and activity feeds, the digest and overview tails, and the
  // aggregate changeset with its verb, draft and join overlays. A body
  // that attached none of these had a Changes shade whose controller read
  // a store that was never there, so it waited on a project scan that had
  // long since happened in the shell (row 8's reading, [F08]).
  attachSessionLedgerStore(connection);
  attachSessionStateChangesStore(connection);
  attachDigestStore(connection);
  attachOverviewStore(connection);
  attachSessionActivityStore(connection);
  attachChangesetAllStore(connection);
  attachChangesetVerbStore(connection);
  attachChangesetDraftStore(connection);
  const joinStore = attachChangesetJoinStore(connection);
  const changesetAll = getChangesetAllStore();
  if (changesetAll !== null) {
    changesetAll.subscribe(() => joinStore.observeFeed(changesetAll.getSnapshot()));
    joinStore.observeFeed(changesetAll.getSnapshot());
  }
  // What those stores' first requests wait on: the listing, the state
  // changes, the digest's and the Overview's ledger tails.
  registerStoreTailActions();
  // Whether this machine carries a git Tug can use: the shade's non-repo
  // and no-git notices read the answer, and an unprobed store shows neither.
  registerAction("host_tools_result", (payload) => applyHostToolsResultPayload(payload));
  registerAction("host_tools_offer_result", (payload) => applyHostToolsOfferResultPayload(payload));
  // Asked on every open of the wire, the first included: a frame sent before
  // the socket is open is dropped, so an ask right after `connect()` was lost.
  connectionLifecycle.observeConnectionDidOpen(() => connection.sendControlFrame("check_host_tools"));
  connection.connect();
  // The maker kinds load beside the snapshot and the WASM, not after them.
  const [, , makerTooling] = await Promise.all([
    tugbankClient.ready(),
    initTugmark({ module_or_path: wasmUrl }),
    loadMakerTooling(getSettings()),
  ]);

  keyboardAccessStore.initialize(normalizeKeyboardAccessMode(readKeyboardAccess(tugbankClient)));
  keymapOverrideStore.initialize(tugbankClient.readDomain(KEYMAP_DOMAIN));
  // A rebind written anywhere — the Settings card, another window, `tugbank
  // write` — reaches this page's chords and tooltip chips as it reaches the
  // shell's (`main.tsx`): a card that draws its own title bar shows its
  // controls' chords here.
  tugbankClient.onDomainChanged((domain, entries) => {
    if (domain === KEYMAP_DOMAIN) keymapOverrideStore.applyRemote(entries);
  });
  // How long this body may stay hidden before it goes dormant: the constant,
  // unless the harness has shortened it (`harnessBodyDelays`).
  const readDormantAfter = () => harnessBodyDelays.getSnapshot().dormantAfterMs ?? DORMANT_AFTER_MS;
  bodyVisibilityStore.setDormantAfterMs(readDormantAfter());
  harnessBodyDelays.subscribe(() => bodyVisibilityStore.setDormantAfterMs(readDormantAfter()));
  initMotionObserver();
  // The body's own motion guard: its loops take holds in this page's
  // registry, so the probe, the input-latency observer and
  // `window.__tugMotion` have to be this page's too, or nothing measures or
  // reports them.
  installMotionGuard();
  // Every kind the shell registers, maker kinds included where the shell has
  // them, so a body — the spare above all — can mount whichever kind it is
  // bound to.
  registerCardKinds({ maker: makerTooling });

  // The acks and requests every page answers on CONTROL.
  connection.onFrame(FeedId.CONTROL, (payload) => {
    try {
      dispatchAction(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
    } catch (error) {
      console.error("body: failed to parse a Control frame", error);
    }
  });
  registerEvalAction(connection);

  onHostMessage(bodyBindToPage, (bind) => {
    void bindBody(bind);
  });
  // Whether the host has this body shown; hidden long enough, it goes dormant.
  onHostMessage(bodyVisibilityToPage, (visibility) => {
    bodyVisibilityStore.apply(visibility);
  });
  // The host is about to carry this card's box to a new size: pin every
  // preserve scroller across it, as the shell's own crossing does for an
  // in-document card, and only then tell the host it may set the final
  // size — the host's resize would race the pin otherwise. The host calls
  // this in the task it runs the plan in, so the pin costs one hop to this
  // page and one back, inside a display period.
  //
  // A `begin` that asks for the solve is the page's whole set-up: after the
  // host's resize lands it ends the episode — the restore, at the new size —
  // waits for a quiet frame, and says `crossingSolved` (`crossing-solve.ts`),
  // so the land has nothing left to end. One without it is a page the host
  // keeps at its size to the land, which ends the episode there. Either way
  // the page's land record reads what the land cost (`body-land.ts`) —
  // stamped before any episode ends, so an end there is the land's.
  //
  // The acknowledgement carries the page's own surface as sRGB bytes: the
  // host paints the container in it for the crossing, so where a shrinking
  // box is still larger than the page at its final size the strip the page
  // does not reach is the body's surface, never the floor beneath.
  let crossing: ResizeEpisodeHandle | null = null;
  let cancelSolve: (() => void) | null = null;
  const bodyLand = createBodyLand({
    cardId: () => page.cardId ?? "",
    enabled: () => deckTrace.isKindEnabled("body-land"),
    now: () => performance.now(),
    wallNow: () => Date.now(),
    raf: (cb) => requestAnimationFrame(cb),
    cancelRaf: (id) => cancelAnimationFrame(id),
    recorder: landRecorder,
    record: (row) => deckTrace.record({ kind: "body-land", ...row }),
  });
  onHostMessage(bodyCrossingToPage, (next) => {
    if (next.phase === "land") bodyLand.land();
    cancelSolve?.();
    cancelSolve = null;
    crossing?.end();
    crossing = null;
    if (next.phase !== "begin") return;
    const root = document.getElementById("deck-container") ?? document.body;
    bodyLand.begin();
    const episode = beginResizeEpisode(root, next.durationMs ?? 0);
    crossing = episode;
    postToHost(crossingReadyToHost, { surface: pageSurfaceRgba() });
    if (next.solve !== true) return;
    cancelSolve = runCrossingSolve({
      now: () => performance.now(),
      raf: (cb) => requestAnimationFrame(cb),
      cancelRaf: (id) => cancelAnimationFrame(id),
      setTimer: (cb, ms) => window.setTimeout(cb, ms),
      clearTimer: (id) => window.clearTimeout(id),
      onResize: (cb) => {
        window.addEventListener("resize", cb, { once: true });
        return () => window.removeEventListener("resize", cb);
      },
      endEpisode: () => {
        episode.end();
        if (crossing === episode) crossing = null;
      },
      quietSince: (t) => landRecorder.quietSince(t),
      solved: ({ resizeMissed }) => {
        cancelSolve = null;
        const foldLanded = foldLandedNow();
        bodyLand.markSolved({ foldLanded, resizeMissed });
        // A fold that has landed names its bottom band, for the host to
        // carry to the closing edge; any other change of a whole card's
        // height names where its picture splits, the head staying at the
        // top and the rest riding the edge. The layout is quiet, so the
        // read is free.
        postToHost(crossingSolvedToHost, {
          band: foldLanded === true ? readCrossingBand(document) : null,
          anchor: foldLanded === null ? readCrossingAnchor(document) : null,
        });
      },
    });
  });
  postToHost(bodyHelloToHost, {});
})();

/**
 * Whether this page's card stands in its folded form now: `true` once the
 * fold has landed on the card host, `false` while it is folding and has not,
 * `null` when the card is not folded at all.
 *
 * Landed is the generic form's `data-card-fold="settled"` on the host
 * (`folded-body.ts`), or, for a card that owns its folded form, its own
 * root's `data-fold="settled"` (the Session card's, in `session-card.tsx`).
 */
function foldLandedNow(): boolean | null {
  const host = document.querySelector<HTMLElement>("[data-card-host]");
  const frame = host?.closest<HTMLElement>("[data-folded]") ?? null;
  if (host == null || frame?.getAttribute("data-folded") !== "true") return null;
  return host.getAttribute(CARD_FOLD_ATTR) === "settled" || host.querySelector('[data-fold="settled"]') !== null;
}
