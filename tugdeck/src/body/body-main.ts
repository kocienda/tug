/**
 * A card's body page: one card, in a web view of its own, on a connection of
 * its own, bridged to the shell.
 *
 * A body boots one of two ways and is bound one way. A cold body loads
 * `/?body=<cardId>` and its hello names its card; the warm spare loads
 * `/?body=spare` and its hello names `spare:<pageId>`. Either connects, waits
 * for the tugbank snapshot and the markdown WASM as the shell does, registers
 * its card kinds, `eval` and the session acks, and posts `bodyHello`. The host
 * answers with `onBodyBind({cardId, intent, facts})`; a spare first takes its
 * card from tugcast with `page_bind`. Then the page builds the card's deck
 * bridge, mounts the card with one `root.render()` ([L01]), replays the
 * intent, and posts `frontendReady` one paint after the card's session goes
 * quiet, or at the arrival bound, whichever comes first.
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
import type { DeckFacts } from "@tugproto/bus";
import { TugConnection } from "../connection";
import { FeedId } from "../protocol";
import { installDomForensics } from "../lib/dom-forensics";
import { installGestureScope } from "../lib/gesture-scope";
import { setConnection } from "../lib/connection-singleton";
import { TugbankClient } from "../lib/tugbank-client";
import { setTugbankClient } from "../lib/tugbank-singleton";
import { ConnectionLifecycle, registerConnectionLifecycle } from "../lib/connection-lifecycle";
import { registerDeckStore } from "../lib/deck-store-registry";
import { registerCardLifecycle } from "../lib/card-lifecycle";
import { AppLifecycle, registerAppLifecycle } from "../lib/app-lifecycle";
import { SheetLifecycle, registerSheetLifecycle } from "../lib/sheet-lifecycle";
import { BannerLifecycle, registerBannerLifecycle } from "../lib/banner-lifecycle";
import { installLifecycleCascade } from "../lib/lifecycle-cascade";
import { dispatchAction, registerAction, registerEvalAction } from "../action-dispatch";
import { dispatchCommand, setUnhandledCommandFallback } from "../command-dispatch";
import { bodyCardFilter, registerSessionControlActions } from "../lib/session-control-actions";
import { cardSessionBindingStore } from "../lib/card-session-binding-store";
import { cardServicesStore } from "../lib/card-services-store";
import { restoreSessions } from "../lib/session-restore";
import { interruptLiveSessions, type TerminationVerdict } from "../teardown";
import {
  putCardState,
  readCardStates,
  readFocusRingModality,
  readKeyboardAccess,
} from "../settings-api";
import { keyboardAccessStore, normalizeKeyboardAccessMode } from "../keyboard-access-store";
import { KEYMAP_DOMAIN, keymapOverrideStore } from "../keymap-override-store";
import { focusRingModalityStore, normalizeFocusRingModality } from "../focus-ring-modality-store";
import { applyTheme, followShellTheme, getOnScreenTheme } from "../contexts/theme-provider";
import { pageZoomStore } from "../lib/page-zoom-store";
import { initMotionObserver } from "../lib/scale-timing";
import { initBodyHostMenuState } from "../lib/host-menu-state";
import { scheduleAfterPaint } from "../lib/after-paint";
import { setKeyboardYield } from "../lib/keyboard-yield";
import { ARRIVAL_REVEAL_BOUND_MS } from "../lib/arrival-reveal";
import { onBus, sendBus } from "../lib/deck-bus";
import { registerSessionCard } from "../components/tugways/cards/session-card-registration";
import { tugDevLogStore } from "../lib/tug-dev-log-store/tug-dev-log-store";
import { BodyDeckBridge } from "./body-deck-bridge";
import { renderBodyRoot } from "./body-root";
import { installBodyPublisher } from "./body-publisher";
import { parseBodyIntent, replayBodyIntent, type BodyIntent } from "./body-intent";

/** The component id of the card kind a body holds. */
const SESSION_COMPONENT_ID = "session";

/** The facts the host hands a body at bind, from the shell's deck. */
interface BindFacts {
  theme?: string;
  zoom?: number;
  keyboardAccess?: boolean;
  appActive?: boolean;
}

/** What the host passes `onBodyBind`. */
interface BodyBind {
  cardId: string;
  intent: unknown;
  facts?: BindFacts;
}

declare global {
  interface Window {
    __tugBridge?: Record<string, unknown> & {
      onBodyBind?: (bind: BodyBind) => void;
    };
  }
}

/** Post `name` to the host, or do nothing outside it. */
function postToHost(name: string, body: unknown): void {
  const handlers = (window as unknown as {
    webkit?: { messageHandlers?: Record<string, { postMessage: (v: unknown) => void } | undefined> };
  }).webkit?.messageHandlers;
  handlers?.[name]?.postMessage(body);
}

installDomForensics();
installGestureScope(window);
followShellTheme();
document.documentElement.setAttribute("data-body-page", "");
// A body that is not the key card never focuses anything: a DOM focus
// asks the window to make this web view the first responder, which would
// take the keyboard from the page that has it. Until bound, that is always.
setKeyboardYield(() => true);

const named = new URLSearchParams(window.location.search).get("body");
const isSpare = named === "spare";
const connection = new TugConnection(`ws://${window.location.host}/ws`, {
  host: "worker",
  page: { role: "body", cardId: isSpare ? null : named },
});
const connectionLifecycle = new ConnectionLifecycle();
connection.setLifecycle(connectionLifecycle);
registerConnectionLifecycle(connectionLifecycle);
setConnection(connection);
const tugbankClient = new TugbankClient(connection);
setTugbankClient(tugbankClient);

const isTestMode = window.__tugTestMode === true;

/** Durable card-state writes, held back in test mode as the deck holds its own. */
function putCardStateGuarded(
  cardId: string,
  bag: Parameters<typeof putCardState>[1],
  options?: Parameters<typeof putCardState>[2],
): Promise<boolean> {
  if (isTestMode && window.__tugPersistInTestMode !== true) return Promise.resolve(true);
  return putCardState(cardId, bag, options);
}

/** Take the shell's deck facts this page renders against. */
function applyDeckFacts(facts: Partial<DeckFacts>, bridge: BodyDeckBridge | null): Promise<void> {
  if (typeof facts.keyboardAccess === "boolean") {
    keyboardAccessStore.setMode(facts.keyboardAccess ? "accessibility" : "standard", { persist: false });
  }
  if (typeof facts.appActive === "boolean") bridge?.setHasFocus(facts.appActive);
  if (typeof facts.zoom === "number") {
    if (bridge === null) pageZoomStore.report(facts.zoom);
    else void pageZoomStore.apply(facts.zoom);
  }
  if (typeof facts.theme === "string" && facts.theme !== getOnScreenTheme()) {
    return applyTheme(facts.theme).then(() => undefined);
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
 * whichever is first ([L05]: the paint is waited on with `scheduleAfterPaint`
 * from the quiet's own notify; its deadline covers a page whose frames are
 * suspended). The layer turns shown just before, so the card's deferred
 * restore lands while the container is still hidden.
 */
function signalReadyWhenQuiet(cardId: string, bridge: BodyDeckBridge): void {
  let done = false;
  const releases: Array<() => void> = [];
  const ready = (): void => {
    if (done) return;
    done = true;
    for (const release of releases) release();
    scheduleAfterPaint(() => {
      bridge.revealLayer();
      postToHost("frontendReady", {});
    });
  };
  const quiet = (): boolean => {
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
  releases.push(cardServicesStore.subscribe(follow), () => releaseSession?.());
  const bound = window.setTimeout(ready, ARRIVAL_REVEAL_BOUND_MS);
  releases.push(() => window.clearTimeout(bound));
  follow();
}

/** Bind this page to `cardId` and bring the card up. */
async function bindBody(bind: BodyBind): Promise<void> {
  const { cardId } = bind;
  if (isSpare && !(await bindSpare(cardId))) return;
  const intent: BodyIntent = parseBodyIntent(bind.intent) ?? { kind: "restore" };

  const restoreBag = !isTestMode || window.__tugRestoreInTestMode === true;
  const bridge = new BodyDeckBridge({
    cardId,
    componentId: SESSION_COMPONENT_ID,
    advise: (advice) => sendBus(connection, "shell", { kind: "card-advice", payload: advice }),
    putCardState: putCardStateGuarded,
    initialBag: restoreBag ? readCardStates(tugbankClient, [cardId]).get(cardId) : undefined,
  });
  registerDeckStore(bridge);
  registerCardLifecycle(bridge.cardLifecycle);
  setKeyboardYield(() => bridge.getFirstResponderCardId() !== cardId);
  const appLifecycle = new AppLifecycle();
  registerAppLifecycle(appLifecycle);
  const sheetLifecycle = new SheetLifecycle();
  registerSheetLifecycle(sheetLifecycle);
  const bannerLifecycle = new BannerLifecycle();
  registerBannerLifecycle(bannerLifecycle);
  installLifecycleCascade(bridge.cardLifecycle, appLifecycle);

  // The session acks this card holds, and no other card's. The card's
  // sessions are read fresh per ack, so a rebind is admitted at once.
  registerSessionControlActions(
    bodyCardFilter(() => {
      const binding = cardSessionBindingStore.getBinding(cardId);
      const sessions = binding === undefined
        ? intent.kind === "restore" ? [] : [intent.tugSessionId]
        : [binding.tugSessionId, ...(binding.seatedSessionId === undefined ? [] : [binding.seatedSessionId])];
      return { cardId, sessionIds: sessions, lineId: binding?.lineId ?? null };
    }),
  );
  cardServicesStore.attachBody();
  // What this page's chain does not answer — a chord its funnel matched
  // for the deck, a close the pane handles — is the shell's: it dispatches
  // in its own chain, where the pane and the deck stand.
  setUnhandledCommandFallback((entry, payload) => {
    sendBus(connection, "shell", {
      kind: "card-advice",
      payload: { advice: "dispatch", id: entry.id, ...(payload !== undefined ? { payload } : {}) },
    });
    return true;
  });
  // The session set follows the card's binding: a rotation seats a new segment.
  cardSessionBindingStore.subscribe(() => {
    const binding = cardSessionBindingStore.getBinding(cardId);
    if (binding === undefined) return;
    connection.setSessions(
      binding.seatedSessionId === undefined
        ? [binding.tugSessionId]
        : [binding.tugSessionId, binding.seatedSessionId],
    );
  });

  await applyDeckFacts(bind.facts ?? {}, null);
  onBus(connection, "deck-facts", (message) => {
    void applyDeckFacts(message.payload, bridge);
  });
  onBus(connection, "card-context", (message) => bridge.applyContext(message.payload));
  // A card-scoped menu command the shell routed here runs against this
  // page's own chain, whose key card is the card's pane responder
  // (`BodyRoot`). The other commands are not a body's yet.
  onBus(connection, "card-command", (message) => {
    if (message.payload.command !== "dispatch" || message.payload.id === undefined) return;
    dispatchCommand(message.payload.id, message.payload.payload);
  });

  initBodyHostMenuState(bridge);
  if (isTestMode) {
    const surface = await import("../test-surface");
    surface.attachBodyTestSurface(bridge);
  }

  createRoot(document.getElementById("deck-container") ?? document.body).render(
    renderBodyRoot({
      bridge,
      componentId: SESSION_COMPONENT_ID,
      appLifecycle,
      sheetLifecycle,
      bannerLifecycle,
    }),
  );
  bridge.cardLifecycle.notifyCardDidFinishConstruction(cardId);
  installBodyPublisher(
    cardId,
    () => bridge.getFirstResponderCardId() === cardId,
    (message) => sendBus(connection, "shell", message),
  );

  replayBodyIntent(intent, cardId, connection, bridge);

  // After a tugcast restart this page re-asserts its card exactly as the
  // shell re-asserts its own: a spare that took its card takes it again, and
  // the card restores from the ledger.
  connectionLifecycle.observeConnectionDidReconnect(() => {
    if (isSpare) connection.sendControlFrame("page_bind", { card_id: cardId });
    cardSessionBindingStore.clearAll();
    restoreSessions(bridge, connection, { reason: "reconnect" });
  });

  window.tugdeck = {
    saveState: () => {
      void bridge.saveNow({ sync: true });
    },
    prepareForTermination: async (): Promise<TerminationVerdict> => {
      const started = performance.now();
      const { interrupted, unacknowledged } = await interruptLiveSessions();
      const saved = await bridge.saveNow();
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
    reconnect: () => connection.forceReconnect(),
  } as unknown as typeof window.tugdeck;

  signalReadyWhenQuiet(cardId, bridge);
}

(async () => {
  connection.connect();
  await Promise.all([tugbankClient.ready(), initTugmark({ module_or_path: wasmUrl })]);

  keyboardAccessStore.initialize(normalizeKeyboardAccessMode(readKeyboardAccess(tugbankClient)));
  focusRingModalityStore.initialize(normalizeFocusRingModality(readFocusRingModality(tugbankClient)));
  keymapOverrideStore.initialize(tugbankClient.readDomain(KEYMAP_DOMAIN));
  initMotionObserver();
  registerSessionCard();

  // The acks and requests every page answers on CONTROL.
  connection.onFrame(FeedId.CONTROL, (payload) => {
    try {
      dispatchAction(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
    } catch (error) {
      console.error("body: failed to parse a Control frame", error);
    }
  });
  registerEvalAction(connection);

  window.__tugBridge = window.__tugBridge ?? {};
  window.__tugBridge.onBodyBind = (bind: BodyBind) => {
    void bindBody(bind);
  };
  postToHost("bodyHello", {});
})();
