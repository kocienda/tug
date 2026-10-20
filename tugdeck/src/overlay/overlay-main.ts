/**
 * The overlay page: the transparent page the host keeps above every card.
 *
 * It holds the transient surfaces nothing beneath it may draw ([B07]): the
 * app-modals, the alerts the shell raises, and the update notice
 * (`overlay-root.tsx`), each sorted in `overlay-census.ts`. It is a page on
 * the bus as a card's body is, under the reserved card id
 * {@link OVERLAY_CARD_ID}: the stores the shell keeps for it are scoped to
 * that id alone, and the deck stores every page reads (`deck.facts`,
 * `deck.cards`) reach it as they reach a body. It has a connection of its
 * own, so the setup wizard's tugcast frames — which tugcast broadcasts to
 * every page — arrive here directly.
 *
 * The boot is a body's without the card: connect, wait for tugbank, register
 * what this page answers, follow what the shell relays, say hello, and
 * render once ([L01]). Its claim on the pointer goes to the host as the page
 * changes (`overlay-claim.ts`).
 *
 * Nothing here imports `main.tsx` or `body-main.ts`: `entry.ts` loads this
 * module for `?overlay=`.
 *
 * @module overlay/overlay-main
 */

import "../css-imports";
import "./overlay-page.css";

import { createRoot } from "react-dom/client";
import { cycleFocusMode, dispatchAction, registerAction, registerEvalAction, registerSetupActions } from "../action-dispatch";
import {
  overlayAppModal,
  overlayCloseOpenQuickly,
  overlayLiveTurns,
  overlayNetworkPath,
  overlayOpenConfigure,
  overlayOpenFile,
  overlayOpenQuickly,
  overlayRestoreGate,
  overlayUpdateAction,
  overlayUpdateState,
} from "../bus/declarations/overlay";
import { deckFacts, deckFrontmostProject } from "../bus/declarations/deck";
import { installPage, page } from "../bus/page";
import { createPageBus, installPageBus, pageBus } from "../bus/page-bus";
import type { SharedStore } from "../bus/shared-store";
import { connectionTransport } from "../bus/transport";
import { TugConnection } from "../connection";
import { applyTheme, followShellTheme, getOnScreenTheme } from "../contexts/theme-provider";
import { focusRingModalityStore, normalizeFocusRingModality } from "../focus-ring-modality-store";
import { installHostChannel, postToHost } from "../host/channel";
import { overlayClaimToHost } from "../host/declarations/overlay";
import { keyboardAccessStore, normalizeKeyboardAccessMode } from "../keyboard-access-store";
import { KEYMAP_DOMAIN, keymapOverrideStore } from "../keymap-override-store";
import { applyShellModifierLatch } from "../components/tugways/modifier-latch";
import { advanceKeyViewFocus, getFocusManager } from "../components/tugways/focus-manager";
import { TUG_ACTIONS } from "../lib/action-vocabulary";
import { appModalStore } from "../lib/app-modal-store";
import { showConfigureTugOnDemand } from "../lib/configure-tug-request-store";
import { ConnectionLifecycle, registerConnectionLifecycle } from "../lib/connection-lifecycle";
import { setConnection } from "../lib/connection-singleton";
import { flushSync, installGestureScope, NEVER_HELD } from "../lib/gesture-scope";
import { setKeyboardYield } from "../lib/keyboard-yield";
import { liveTurnsStore } from "../lib/live-turns-store";
import { motionBreaker } from "../lib/motion-guard/breaker";
import { networkPathStore } from "../lib/network-path-store";
import { relayFrontmostProjectBinding } from "../lib/frontmost-project";
import { adoptOpenQuicklyOpen, setOpenQuicklyCloseSink, setOpenQuicklyFileSink } from "../lib/open-quickly-store";
import { OVERLAY_CARD_ID } from "../lib/overlay-card";
import { pageZoomStore } from "../lib/page-zoom-store";
import { restoreGateStore } from "../lib/restore-gate-store";
import { initMotionObserver } from "../lib/scale-timing";
import { transportStateStore } from "../lib/transport-state-store";
import { TugbankClient } from "../lib/tugbank-client";
import { setTugbankClient } from "../lib/tugbank-singleton";
import { setUpdateActionSink, updateStore } from "../lib/update-store";
import { readKeyboardAccess } from "../settings-api";
import { FeedId } from "../protocol";
import { createOverlayGateDeck } from "./overlay-gate-deck";
import { installOverlayClaim } from "./overlay-claim";
import { installOverlayDrawing } from "./overlay-drawing";
import { renderOverlayRoot } from "./overlay-root";

/** Call `apply` with `store`'s value now, if it has arrived, and whenever it changes. */
function follow<T>(store: SharedStore<T>, apply: (value: T) => void): void {
  store.subscribe(() => apply(store.getSnapshot()));
  if (store.arrived()) apply(store.getSnapshot());
}

installGestureScope(window);
followShellTheme();
installHostChannel();
document.documentElement.setAttribute("data-overlay-page", "");

installPage({ role: "body", cardId: OVERLAY_CARD_ID, componentId: OVERLAY_CARD_ID });
const connection = new TugConnection(`ws://${window.location.host}/ws`, {
  host: "worker",
  page: { role: "body", cardId: OVERLAY_CARD_ID },
  // The overlay's frames are its own: it streams through the shell's settles.
  motionGate: NEVER_HELD,
});
const connectionLifecycle = new ConnectionLifecycle();
connection.setLifecycle(connectionLifecycle);
registerConnectionLifecycle(connectionLifecycle);
setConnection(connection);
installPageBus(createPageBus(connectionTransport(connection, connectionLifecycle), page));
const tugbankClient = new TugbankClient(connection);
setTugbankClient(tugbankClient);

// The wire's state, which the setup wizard reads to show "Reconnecting…"
// rather than a dead wizard when it drops (`main.tsx` feeds the shell's).
connectionLifecycle.observeConnectionDidOpen(() => transportStateStore.set("online"));
connectionLifecycle.observeConnectionDidEnterReconnecting(() => transportStateStore.set("reconnecting"));
connectionLifecycle.observeConnectionDidClose(() => transportStateStore.set("offline"));

// The gates this page shows for the shell take the shell's truth, not their
// own: adopted before anything reads them, so neither store starts a fold of
// a deck this page does not hold.
restoreGateStore.adopt(overlayRestoreGate.getSnapshot());
follow(overlayRestoreGate, (gate) => restoreGateStore.adopt(gate));
// Each update snapshot is committed on its own. The host hands the shell one
// snapshot per task, so React has always seen every stage the flow passed
// through; the relay can hand this page several in one task, and React would
// fold them into one commit — an `idle` between a dismissal and the next find
// would never be rendered, and what reads `idle` as "the flow ended" (the
// wizard's close, the pill's hide reset) would never run.
overlayUpdateState.handle((snapshot) => flushSync(() => updateStore.apply(snapshot)));
follow(overlayLiveTurns, (turns) => liveTurnsStore.adopt(turns));
follow(overlayNetworkPath, (path) => networkPathStore.apply(path));
setUpdateActionSink((action) => overlayUpdateAction.dispatch({ action }));
// The modals this page has up are the app's: the shell's menu reads them.
appModalStore.subscribe(() => overlayAppModal.set(appModalStore.owners()));
overlayOpenConfigure.handle(() => showConfigureTugOnDemand());
// Open Quickly is drawn here and opened by the shell: its open state is the
// shell's, the project it searches is the shell's frontmost, and its close
// and its choice go back.
follow(overlayOpenQuickly, ({ open, seq }) => adoptOpenQuicklyOpen(open, seq));
follow(deckFrontmostProject, ({ binding }) => relayFrontmostProjectBinding(binding));
setOpenQuicklyCloseSink((seq) => overlayCloseOpenQuickly.dispatch({ seq }));
setOpenQuicklyFileSink((path, line) => overlayOpenFile.dispatch({ path, line: line ?? null }));
// The shell's facts every page renders against: the theme, the zoom, the
// keyboard's mode and modality, the held modifiers, the motion switch, and
// whether the app is frontmost — a backgrounded window paints no focus ring
// (`focus-ring.css`), and this page holds no deck to project it from.
//
// The zoom is this page's own root transform, and it is a step only when the
// factor moved: the first factor heard is the standing one, reported with
// no transition, and a fact that changed something else changes no zoom. A
// step raises the zoom readout (drawn in this page) in the task that writes
// the transform.
let zoomHeard = false;
follow(deckFacts, (facts) => {
  keyboardAccessStore.setMode(facts.keyboardAccess ? "accessibility" : "standard", { persist: false });
  focusRingModalityStore.setMode(normalizeFocusRingModality(facts.focusRingModality), { persist: false });
  applyShellModifierLatch(facts.modifierLatch);
  motionBreaker.demote(facts.motionDemoted);
  document.documentElement.setAttribute("data-app-active", facts.appActive ? "true" : "false");
  if (!zoomHeard) {
    zoomHeard = true;
    pageZoomStore.report(facts.zoom);
  } else if (facts.zoom !== pageZoomStore.getFactor()) {
    void pageZoomStore.apply(facts.zoom);
  }
  if (facts.theme !== "" && facts.theme !== getOnScreenTheme()) void applyTheme(facts.theme);
});

(async () => {
  // What the setup wizard reads, answered on this page's own connection, and
  // asked for on every open of the wire: a frame sent before the socket is
  // open is dropped, so the ask waits for the handshake rather than racing it.
  registerSetupActions();
  registerEvalAction(connection);
  // The keyboard walk of a modal standing here — ⌥⇥'s cycle and the View
  // menu's two doors onto the walk — is this page's, as a card's is its
  // body's: the dialog's stops and responders are here.
  registerAction(TUG_ACTIONS.NEXT_KEYBOARD_FOCUS, () => advanceKeyViewFocus(getFocusManager(), 1));
  registerAction(TUG_ACTIONS.PREVIOUS_KEYBOARD_FOCUS, () => advanceKeyViewFocus(getFocusManager(), -1));
  registerAction(TUG_ACTIONS.CYCLE_FOCUS_MODE, cycleFocusMode);
  connection.onFrame(FeedId.CONTROL, (payload) => {
    try {
      dispatchAction(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
    } catch (error) {
      console.error("overlay: failed to parse a Control frame", error);
    }
  });
  const probe = (): void => {
    connection.sendControlFrame("check_auth");
    connection.sendControlFrame("check_claude_version");
    connection.sendControlFrame("check_host_tools");
  };
  connectionLifecycle.observeConnectionDidOpen(probe);
  connection.connect();
  await tugbankClient.ready();
  keyboardAccessStore.initialize(normalizeKeyboardAccessMode(readKeyboardAccess(tugbankClient)));
  keymapOverrideStore.initialize(tugbankClient.readDomain(KEYMAP_DOMAIN));
  tugbankClient.onDomainChanged((domain, entries) => {
    if (domain === KEYMAP_DOMAIN) keymapOverrideStore.applyRemote(entries);
  });
  initMotionObserver();

  // The shell's `lab.dispatch`, in this page, in dev and test builds: a test
  // injects a setup frame where the wizard reads it, as tugcast's broadcast
  // reaches it here.
  if (import.meta.env.DEV || window.__tugTestMode === true) {
    window.tugdeck = {
      lab: {
        dispatch: (action: string, payload?: Record<string, unknown>) => dispatchAction({ ...payload, action }),
      },
    } as unknown as typeof window.tugdeck;
  }
  // The harness's page verbs, in this page, under the harness.
  if (window.__tugTestMode === true) (await import("../test-surface")).attachOverlayTestSurface();
  // The UI faces, loaded before anything is drawn. The shell has been painting
  // text since boot, so a surface it raises finds its faces decoded; this page
  // paints nothing until its first surface, and a face is not fetched until
  // layout asks for it — so without this the first pill or panel lays out in
  // the fallback and changes size when the face lands: the pill's width under
  // its own zoom, a drawn placard's rows under a scroller already pinned to
  // its bottom. Sans for the chrome, mono for the readings the placards list.
  const rootStyle = getComputedStyle(document.documentElement);
  const faces = [
    rootStyle.getPropertyValue("--tug-font-family-sans").trim() || `"IBM Plex Sans"`,
    rootStyle.getPropertyValue("--tug-font-family-mono").trim() || `"IBM Plex Mono"`,
  ];
  await Promise.all(
    faces.flatMap((family) => [400, 500, 600, 700].map((weight) => document.fonts.load(`${weight} 13px ${family}`).catch(() => undefined))),
  );
  pageBus().announce();
  const container = document.getElementById("deck-container");
  if (container === null) throw new Error("overlay: no #deck-container to render into");
  createRoot(container).render(renderOverlayRoot({ gateDeck: createOverlayGateDeck() }));
  installOverlayDrawing();
  // This page holds the keyboard exactly while it claims the whole window:
  // the host makes its view the key one for that span (`overlay-claim.ts`),
  // and outside it the focus engine writes no DOM focus here, which would ask
  // the window to take the keys from the page that has them. A surface is
  // raised a frame before its claim reaches the host, so the engine's grant
  // of its field's caret at mount is declined; the key view is landed again
  // when the page gets the keyboard.
  let holdsKeyboard = false;
  setKeyboardYield(() => !holdsKeyboard);
  window.addEventListener("focus", () => {
    if (holdsKeyboard) getFocusManager()?.focusKeyView();
  });
  // What a reader waits on: the page has rendered its tree and said hello.
  document.documentElement.setAttribute("data-overlay-ready", "");
  installOverlayClaim(document, (claim) => {
    holdsKeyboard = "all" in claim;
    postToHost(overlayClaimToHost, claim);
  });
})();
