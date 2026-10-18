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
 * card from tugcast with `page_bind`. Then the page builds the card's deck
 * bridge, mounts the card of that kind with one `root.render()` ([L01]),
 * replays the intent, and posts `frontendReady` one paint after the card's
 * session goes quiet, or at the arrival bound, whichever comes first — or
 * one paint after mount, for a kind with no session (a `mount` intent).
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
import { installGestureScope, NEVER_HELD } from "../lib/gesture-scope";
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
import { cycleFocusMode, dispatchAction, registerAction, registerEvalAction, registerStoreTailActions } from "../action-dispatch";
import { dispatchCommand, sendToCardContent, setUnhandledCommandFallback } from "../command-dispatch";
import { COMMANDS_BY_ID } from "../components/tugways/command-registry";
import { setUnhandledTargetHook } from "../components/tugways/responder-chain";
import { TUG_ACTIONS } from "../lib/action-vocabulary";
import { bodyCardFilter, registerSessionControlActions } from "../lib/session-control-actions";
import { cardSessionBindingStore } from "../lib/card-session-binding-store";
import { cardServicesStore } from "../lib/card-services-store";
import { chordCaptureState } from "../lib/chord-capture-state";
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
import { setKeyboardYield } from "../lib/keyboard-yield";
import { setFocusWalkEdge } from "../lib/focus-walk-edge";
import { setLogoutForwarder } from "../lib/logout-store";
import { createSurfaceMirror, setShellSurfaceHost } from "../lib/shell-surface";
import { advanceKeyViewFocus, enterKeyViewWalk, getFocusManager } from "../components/tugways/focus-manager";
import { installDictationBridge } from "../lib/dictation-bridge";
import { ARRIVAL_REVEAL_BOUND_MS, type ArrivalQuiet } from "../lib/arrival-reveal";
import { sessionPickerQuiet } from "../components/tugways/cards/session-picker-quiet";
import { onBus, sendBus } from "../lib/deck-bus";
import { pendingAskStore } from "../lib/pending-ask-store";
import { UsageStore } from "../lib/usage-store";
import type { PendingAsk } from "../lib/code-session-store/types";
import { beginResizeEpisode, type ResizeEpisodeHandle } from "../lib/resize-episode";
import { loadMakerTooling, registerCardKinds } from "../card-kinds";
import { tugDevLogStore } from "../lib/tug-dev-log-store/tug-dev-log-store";
import { exposePerfMonitor, startPerfMonitor } from "../lib/perf-monitor";
import { getSettings } from "../lib/maker-mode-bridge";
import { getRegistration, type CardIdentityFacts } from "../card-registry";
import { cardIdentityElsewhere } from "../lib/card-identity";
import { cardActivityElsewhere } from "../lib/card-activity-elsewhere";
import { getOpenTextCard } from "../lib/text-card-open-registry";
import { getCardCloseGuard } from "../lib/card-close-guard";
import { appInfoStore } from "../lib/app-info-store";
import { requestSettingsReveal } from "../lib/settings-reveal";
import { getJotsStore } from "../lib/jots-store";
import { relayFrontmostProjectBinding } from "../lib/frontmost-project";
import { applyCrossingMirror, type CrossingMirror } from "../lib/fold-crossing";
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from "../lib/settings-sections-pref";
import { isTelemetryInspection, telemetryInspectionStore } from "../lib/telemetry-inspection-store";
import { TUG_DEV_LOG_LEVELS, type TugDevLogEntry, type TugDevLogLevel } from "../lib/tug-dev-log-store/types";
import { installInspectionPublisher } from "./body-inspection";
import { cardTitleStore, type CardMastheadPayload } from "../lib/card-title-store";
import type { CardSessionBinding } from "../lib/card-session-binding-store";
import type { BodyArrangement } from "../lib/body-arrangement";
import { cardsSpaceVerbRequest } from "../components/cards/cards-space-verb-request";
import { BodyDeckBridge } from "./body-deck-bridge";
import { renderBodyRoot } from "./body-root";
import { installBodyPublisher } from "./body-publisher";
import { parseBodyIntent, replayBodyIntent, type BodyIntent } from "./body-intent";

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
  /** The kind of card this body holds: the shell's deck's `componentId`. */
  componentId?: unknown;
  intent: unknown;
  facts?: BindFacts;
}

/**
 * What the host passes `onBodyCrossing`: the box is about to change size
 * under the host's beats (`begin`, with the landing size and the plan's
 * span), or those beats have landed or been cancelled (`land`).
 */
interface BodyCrossing {
  phase: "begin" | "land";
  width?: number;
  height?: number;
  durationMs?: number;
}

declare global {
  interface Window {
    __tugBridge?: Record<string, unknown> & {
      onBodyBind?: (bind: BodyBind) => void;
      onBodyCrossing?: (crossing: BodyCrossing) => void;
    };
  }
}

/** Whether `value` is a log entry as the shell relays one, its id left to this page. */
function isRelayedLogEntry(value: unknown): value is Omit<TugDevLogEntry, "id"> {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<Omit<TugDevLogEntry, "id">>;
  return (
    typeof entry.timestamp === "number" &&
    typeof entry.level === "string" &&
    TUG_DEV_LOG_LEVELS.includes(entry.level as TugDevLogLevel) &&
    typeof entry.source === "string" &&
    typeof entry.message === "string"
  );
}

/** Post `name` to the host, or do nothing outside it. */
function postToHost(name: string, body: unknown): void {
  const handlers = (window as unknown as {
    webkit?: { messageHandlers?: Record<string, { postMessage: (v: unknown) => void } | undefined> };
  }).webkit?.messageHandlers;
  handlers?.[name]?.postMessage(body);
}

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
  postToHost("bodySurface", { surface: pageSurfaceRgba() });
}

installDomForensics();
installGestureScope(window);
followShellTheme();
// Receive the host's dictation events here too: the host answers the view
// that sent the `start`, and a body whose composer claimed the mic is that
// view. Without the receiver a body's start was answered into nothing and
// its button stood at "starting" (row 5's reading).
installDictationBridge();
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
  // A body streams through the shell's settles: its frames are its own.
  motionGate: NEVER_HELD,
});
const connectionLifecycle = new ConnectionLifecycle();
connection.setLifecycle(connectionLifecycle);
registerConnectionLifecycle(connectionLifecycle);
setConnection(connection);
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
 * Mirror what the shell holds about cards other than this page's own — their
 * session bindings, titles, live identities and reported session phases —
 * into this page's stores, for an arrangement card that lists them and a
 * following card that names its followed card.
 * Those stores are per page and hold only this card's entries otherwise.
 * Returns the mirror's apply; each apply replaces the last, clearing what it
 * no longer names, and writes only what changed. The page's own card is
 * never written: it owns its entries.
 */
function createCardFactsMirror(ownCardId: string): (
  bindings: Record<string, CardSessionBinding>,
  titles: Record<string, { title: string | null; masthead: CardMastheadPayload | null }>,
  identities: Record<string, CardIdentityFacts>,
  activities: Record<string, string>,
) => void {
  let boundBefore = new Map<string, string>();
  let titledBefore = new Set<string>();
  let knownBefore = new Set<string>();
  let reportedBefore = new Set<string>();
  return (bindings, titles, identities, activities) => {
    const bound = new Map<string, string>();
    for (const [id, binding] of Object.entries(bindings)) {
      if (id === ownCardId) continue;
      const json = JSON.stringify(binding);
      bound.set(id, json);
      if (JSON.stringify(cardSessionBindingStore.getBinding(id)) !== json) cardSessionBindingStore.setBinding(id, binding);
    }
    for (const id of boundBefore.keys()) if (!bound.has(id)) cardSessionBindingStore.clearBinding(id);
    boundBefore = bound;
    const titled = new Set(Object.keys(titles).filter((id) => id !== ownCardId));
    for (const id of titled) {
      const { title, masthead } = titles[id];
      if (title !== null) cardTitleStore.set(id, title, masthead ?? undefined);
      else if (masthead !== null) cardTitleStore.setMasthead(id, masthead);
      else cardTitleStore.clear(id);
    }
    for (const id of titledBefore) if (!titled.has(id)) cardTitleStore.clear(id);
    titledBefore = titled;
    const known = new Set(Object.keys(identities).filter((id) => id !== ownCardId));
    for (const id of known) cardIdentityElsewhere.set(id, identities[id]);
    for (const id of knownBefore) if (!known.has(id)) cardIdentityElsewhere.set(id, null);
    knownBefore = known;
    const reported = new Set(Object.keys(activities).filter((id) => id !== ownCardId));
    for (const id of reported) cardActivityElsewhere.set(id, activities[id]);
    for (const id of reportedBefore) if (!reported.has(id)) cardActivityElsewhere.set(id, null);
    reportedBefore = reported;
  };
}

/** The shell's crossing as this page reads it: a mirror, or null for none or for a shape it is not. */
function asCrossingMirror(value: unknown): CrossingMirror | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  const stamp = (v: unknown): boolean => v === null || typeof v === "number";
  return stamp(m.still) && stamp(m.fold) && typeof m.held === "object" && m.held !== null
    ? (value as CrossingMirror)
    : null;
}

/** The shell's frontmost binding as this page reads it: a binding, or null for none or for a shape it is not. */
function asFrontmostBinding(value: unknown): CardSessionBinding | null {
  if (typeof value !== "object" || value === null) return null;
  const b = value as Record<string, unknown>;
  return typeof b.tugSessionId === "string" && typeof b.workspaceKey === "string" && typeof b.projectDir === "string"
    ? (value as CardSessionBinding)
    : null;
}

/** Take the shell's deck facts this page renders against. */
function applyDeckFacts(facts: Partial<DeckFacts>, bridge: BodyDeckBridge | null): Promise<void> {
  if (typeof facts.keyboardAccess === "boolean") {
    keyboardAccessStore.setMode(facts.keyboardAccess ? "accessibility" : "standard", { persist: false });
  }
  // Facts, followed and never persisted: the shell's modality, and the
  // modifiers the shell's key events say are held.
  if (typeof facts.focusRingModality === "string") {
    focusRingModalityStore.setMode(normalizeFocusRingModality(facts.focusRingModality), { persist: false });
  }
  if (Array.isArray(facts.modifierLatch)) applyShellModifierLatch(facts.modifierLatch);
  if (typeof facts.appActive === "boolean") bridge?.setHasFocus(facts.appActive);
  // The shell's hand switch, followed: the body's own root attribute stills
  // its loops, and clearing it resumes them through the body's breaker.
  if (typeof facts.motionDemoted === "boolean") motionBreaker.demote(facts.motionDemoted);
  if (facts.frontmostProject !== undefined) {
    relayFrontmostProjectBinding(asFrontmostBinding(facts.frontmostProject.binding));
  }
  if (typeof facts.zoom === "number") {
    if (bridge === null) pageZoomStore.report(facts.zoom);
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
 * the bus to the shell, behind every `card-facts` this page has sent. The
 * shell draws the card's chrome from those facts — a Session card's masthead
 * grows its title bar by 52 pt — so it shows the body only once it has heard
 * both: the host's word alone can outrun the facts and place the body under
 * chrome that is about to move it (`at0738-body-arrival`).
 */
function signalReadyWhenQuiet(cardId: string, bridge: BodyDeckBridge, mounting: boolean): void {
  let done = false;
  const releases: Array<() => void> = [];
  const ready = (): void => {
    if (done) return;
    done = true;
    for (const release of releases) release();
    scheduleAfterPaint(() => {
      bridge.revealLayer();
      postToHost("frontendReady", {});
      postSurface();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          postToHost("painted", {});
          sendBus(connection, "shell", { kind: "card-advice", payload: { advice: "painted" } });
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
  if (typeof bind.componentId !== "string" || bind.componentId.length === 0) {
    tugDevLogStore.error("body", "onBodyBind named no componentId; not binding", { cardId });
    return;
  }
  const componentId = bind.componentId;
  if (isSpare && !(await bindSpare(cardId))) return;
  const intent: BodyIntent = parseBodyIntent(bind.intent) ?? { kind: "restore" };

  const restoreBag = !isTestMode || window.__tugRestoreInTestMode === true;
  const registration = getRegistration(componentId);
  const bridge = new BodyDeckBridge({
    cardId,
    componentId,
    deckMode: registration?.bodyDeck === "arrangement" ? "arrangement" : "card",
    advise: (advice) => sendBus(connection, "shell", { kind: "card-advice", payload: advice }),
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
  registerDeckStore(bridge);
  registerCardLifecycle(bridge.cardLifecycle);
  setKeyboardYield(() => bridge.getFirstResponderCardId() !== cardId);
  // This page holds the card's own stops; its chrome's are the shell's. So
  // a Tab off either end of the walk goes to the shell, which takes it into
  // the chrome or hands it back here at the end it came in by ([F05]).
  const exitWalk = (direction: 1 | -1, empty: boolean): void => {
    sendBus(connection, "shell", {
      kind: "card-advice",
      payload: { advice: "focus-exit", direction: direction === 1 ? "next" : "previous", ...(empty ? { empty } : {}) },
    });
  };
  setFocusWalkEdge((direction) => {
    exitWalk(direction, false);
    return true;
  });
  // The View menu's two doors onto the walk, which the shell hands here
  // while the card's stops are this page's.
  registerAction(TUG_ACTIONS.NEXT_KEYBOARD_FOCUS, () => {
    advanceKeyViewFocus(getFocusManager(), 1);
  });
  registerAction(TUG_ACTIONS.PREVIOUS_KEYBOARD_FOCUS, () => {
    advanceKeyViewFocus(getFocusManager(), -1);
  });
  // ⌥⇥ toggles the card's own cycle, so it is answered here, where the
  // card's responders and stops are; unregistered, it would go to the shell.
  registerAction(TUG_ACTIONS.CYCLE_FOCUS_MODE, cycleFocusMode);
  // What the card raises past its own content box — the Z2 placard — the
  // shell draws, and a logout is the app's, which only the shell mounts.
  const surfaces = createSurfaceMirror((surface) => {
    sendBus(connection, "shell", { kind: "card-advice", payload: { advice: "surface", surface } });
  });
  setShellSurfaceHost(surfaces);
  setLogoutForwarder(() => {
    sendBus(connection, "shell", { kind: "card-advice", payload: { advice: "logout" } });
  });
  // A chord capture armed in this card parks the host's menu bar, and the
  // menu state is the shell's to push: the body says when its capture arms
  // and disarms, and the shell folds that into its own flag. The page is
  // bound once, so the subscription lives as long as it does.
  chordCaptureState.subscribe(() => {
    sendBus(connection, "shell", {
      kind: "card-advice",
      payload: { advice: "capture-armed", armed: chordCaptureState.isArmed() },
    });
  });
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
        ? intent.kind === "restore" || intent.kind === "mount" ? [] : [intent.tugSessionId]
        : [binding.tugSessionId, ...(binding.seatedSessionId === undefined ? [] : [binding.seatedSessionId])];
      return { cardId, sessionIds: sessions, lineId: binding?.lineId ?? null };
    }),
  );
  cardServicesStore.attachBody(cardId);
  // What this page's chain does not answer — a chord its funnel matched
  // for the deck, a close the pane handles — is the shell's: it dispatches
  // in its own chain, where the pane and the deck stand.
  //
  // Cancel is the one command declined rather than forwarded. The funnel
  // consumes a chord whose dispatch reports it handled, and a fallback that
  // claimed Cancel would spend every Escape nothing in this page wanted —
  // the completion popup's, the editor's — before they saw it; and a body
  // holding the keyboard has no shell surface ahead of it for the shell to
  // cancel. The shell's own chain declines an unanswered Cancel the same
  // way, and the key goes on to the surface that owns it ([F17]).
  //
  // Undo and Redo are declined too. An edit history is the focused
  // surface's, and nothing the shell holds answers for this card's; what
  // this page's chain leaves unanswered is a native text control's, whose
  // only undo is the platform's — the Edit menu's, reached when the funnel
  // lets ⌘Z go on. Claimed here, ⌘Z after typing in an input undid nothing.
  setUnhandledCommandFallback((entry, payload) => {
    if (
      entry.id === TUG_ACTIONS.CANCEL_DIALOG ||
      entry.id === TUG_ACTIONS.UNDO ||
      entry.id === TUG_ACTIONS.REDO
    ) {
      return false;
    }
    sendBus(connection, "shell", {
      kind: "card-advice",
      payload: { advice: "dispatch", id: entry.id, ...(payload !== undefined ? { payload } : {}) },
    });
    return true;
  });
  // A control's action sent to its parent responder that this page's chain
  // does not answer — the Cards card's New Workspace, its header's Rename
  // and Delete — is a registered command the shell's deck answers.
  setUnhandledTargetHook((event) => {
    const entry = COMMANDS_BY_ID.get(event.action);
    if (entry === undefined || entry.id === TUG_ACTIONS.CANCEL_DIALOG) return false;
    sendBus(connection, "shell", {
      kind: "card-advice",
      payload: { advice: "dispatch", id: entry.id, ...(event.value !== undefined ? { payload: { value: event.value } } : {}) },
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
    if (message.payload.menu !== undefined) applyShellMenuFacts(message.payload.menu);
  });
  // The cards the shell lists for an arrangement card, and the card a
  // following card follows, come with their bindings and titles: mirrored
  // before the bridge notifies, so the card's first read of them finds them.
  const mirror = createCardFactsMirror(cardId);
  let lastSpaceVerbToken = 0;
  onBus(connection, "card-context", (message) => {
    // The crossing the shell's pane stands under, held here on this page's
    // own frame so the card root holds through it as an in-document one does.
    const frame = document.querySelector<HTMLElement>(".body-pane-frame");
    if (frame !== null) applyCrossingMirror(frame, asCrossingMirror(message.payload.crossing));
    const arrangement = message.payload.arrangement as BodyArrangement | undefined;
    const followed = message.payload.followed as
      | { cardId: string; binding: CardSessionBinding | null }
      | null
      | undefined;
    if (arrangement !== undefined || followed !== undefined) {
      const bindings = { ...(arrangement?.bindings ?? {}) };
      if (followed?.binding != null) bindings[followed.cardId] = followed.binding;
      mirror(bindings, arrangement?.titles ?? {}, arrangement?.identities ?? {}, arrangement?.activities ?? {});
    }
    // The app's identity the host sent the shell, for the About card.
    const appInfo = message.payload.appInfo;
    if (typeof appInfo === "object" && appInfo !== null) appInfoStore.setFromPayload(appInfo as Record<string, unknown>);
    // A workspace verb the shell's menu asked the Cards card to answer: put it
    // in this page's slot, once per request, where the card reads it.
    const verb = arrangement?.spaceVerb ?? null;
    if (verb !== null && verb.token !== lastSpaceVerbToken) {
      lastSpaceVerbToken = verb.token;
      cardsSpaceVerbRequest.request(verb.verb, verb.spaceId);
    }
    bridge.applyContext(message.payload);
  });
  // The inspection this card publishes for a devtools card that follows it,
  // while the shell says one does.
  let releaseInspection: (() => void) | null = null;
  // A question the shell holds, shown in this card's dialog: the press goes
  // back to the shell, which answers the caller.
  pendingAskStore.forwardResponses((requestId, choice) => {
    sendBus(connection, "shell", { kind: "card-advice", payload: { advice: "ask-response", requestId, choice } });
  });
  onBus(connection, "card-command", (message) => {
    // The walk coming back in from the shell lands on this page's first
    // or last stop; with none, it goes back out, marked so the shell keeps
    // it rather than handing it here again.
    if (message.payload.command === "focus-enter") {
      const edge = message.payload.edge ?? "first";
      if (!enterKeyViewWalk(getFocusManager(), edge)) exitWalk(edge === "first" ? 1 : -1, true);
      return;
    }
    // A press in, or the dismissal of, the surface the shell draws for us.
    if (message.payload.command === "surface-activate") {
      surfaces.activate(message.payload.path ?? []);
      return;
    }
    if (message.payload.command === "surface-dismissed") {
      surfaces.dismiss();
      return;
    }
    // A session the shell decided for this card after handing it here — a
    // harness spawn, a resume asked for elsewhere — replayed as the bind's
    // own intent was.
    if (message.payload.command === "intent") {
      const forwarded = parseBodyIntent(message.payload.payload);
      if (forwarded === null) {
        tugDevLogStore.error("body", "a forwarded intent did not parse; ignored", { cardId });
        return;
      }
      replayBodyIntent(forwarded, cardId, connection, bridge);
      return;
    }
    // The shell's close gesture asks this card's own close guard: its sheet
    // comes up here, in the card it concerns, and the answer goes back.
    if (message.payload.command === "close-decision") {
      const guard = getCardCloseGuard(cardId);
      void (guard === null ? Promise.resolve("close" as const) : guard.run()).then((answer) => {
        sendBus(connection, "shell", { kind: "card-advice", payload: { advice: "close-decision", answer } });
      });
      return;
    }
    // A chain action the shell addressed to this card's content: this page's
    // chain holds that responder, and nothing forwards it on from here.
    if (message.payload.command === "content-action") {
      if (message.payload.id !== undefined) sendToCardContent(cardId, message.payload.id);
      return;
    }
    // An open of the file this card holds, from another page: the line it
    // asked for is revealed in this card's own editor.
    if (message.payload.command === "reveal-line") {
      const at = message.payload.payload as { line?: number; endLine?: number; columns?: [number, number] } | undefined;
      if (typeof at?.line === "number") getOpenTextCard(cardId)?.revealLine(at.line, at.endLine, at.columns);
      return;
    }
    // A devtools card in another page follows this one: publish this card's
    // session inspection on each change until told to stop. An `on` while
    // already publishing starts over, so a devtools card that joined late
    // hears the current inspection at once.
    if (message.payload.command === "inspect") {
      releaseInspection?.();
      releaseInspection = null;
      if (message.payload.on === true) {
        releaseInspection = installInspectionPublisher(cardId, (m) => sendBus(connection, "shell", m));
      }
      return;
    }
    // The followed card's inspection, relayed to this devtools card.
    if (message.payload.command === "inspection") {
      const inspection = message.payload.inspection;
      telemetryInspectionStore.relay(isTelemetryInspection(inspection) ? inspection : null);
      return;
    }
    // ⌘J's capture, for this Jots card: the editor opens from this page's store.
    if (message.payload.command === "new-jot") {
      getJotsStore().createJot(null);
      return;
    }
    // A question raised from outside the turn stream, parked on this card's
    // session so its dialog comes up here; `null` takes the dialog down.
    if (message.payload.command === "ask") {
      const ask = (message.payload.payload as { ask?: PendingAsk | null } | undefined)?.ask ?? null;
      cardServicesStore.getServices(cardId)?.codeSessionStore.setPendingAsk(ask);
      return;
    }
    // A reveal the shell parked for the Settings card, now that this page
    // holds it: the card's own consumer takes it.
    if (message.payload.command === "reveal-settings") {
      const section = (message.payload.payload as { section?: unknown } | undefined)?.section;
      if (typeof section === "string" && SETTINGS_SECTION_IDS.includes(section as SettingsSectionId)) {
        requestSettingsReveal(section as SettingsSectionId);
      }
      return;
    }
    // The shell's log, for the devtools card's Log tab: this page logs
    // almost nothing of its own.
    if (message.payload.command === "dev-log") {
      const entries = (message.payload.payload as { entries?: unknown } | undefined)?.entries;
      if (Array.isArray(entries)) tugDevLogStore.adopt("shell", entries.filter(isRelayedLogEntry));
      return;
    }
    // A card-scoped menu command the shell routed here runs against this
    // page's own chain, whose key card is the card's pane responder
    // (`BodyRoot`). The other commands are not a body's yet.
    if (message.payload.command !== "dispatch" || message.payload.id === undefined) return;
    dispatchCommand(message.payload.id, message.payload.payload);
  });

  initBodyHostMenuState(bridge);
  // The `/usage` panel is account-global, and a Session card's sheet reads it
  // from its own page, which asks tugcast on its own connection.
  const usageStore = new UsageStore(connection);
  if (isTestMode) {
    const surface = await import("../test-surface");
    surface.attachBodyTestSurface(bridge, { usageStore });
  }

  createRoot(document.getElementById("deck-container") ?? document.body).render(
    renderBodyRoot({
      bridge,
      componentId,
      appLifecycle,
      sheetLifecycle,
      bannerLifecycle,
      usageStore,
    }),
  );
  bridge.cardLifecycle.notifyCardDidFinishConstruction(cardId);
  installBodyPublisher(
    cardId,
    (message) => sendBus(connection, "shell", message),
  );

  replayBodyIntent(intent, cardId, connection, bridge);

  // After a reconnect this page re-asserts its card exactly as the shell
  // re-asserts its own: a spare that took its card takes it again, and the
  // card is re-bound (the same tugcast) or restored from the ledger (a
  // restarted one).
  connectionLifecycle.observeConnectionDidReconnect(() => {
    if (isSpare) connection.sendControlFrame("page_bind", { card_id: cardId });
    reassertOnReconnect(bridge, connection);
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
    diag: {
      // What this card asked of the deck that only the shell answers.
      shellReads: () => bridge.shellReads(),
      // Whether this card is publishing its inspection for a devtools card.
      inspecting: () => releaseInspection !== null,
    },
  } as unknown as typeof window.tugdeck;

  signalReadyWhenQuiet(cardId, bridge, intent.kind === "mount");
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
  connectionLifecycle.observeConnectionDidReconnect(() => connection.sendControlFrame("check_host_tools"));
  connection.connect();
  connection.sendControlFrame("check_host_tools");
  // The maker kinds load beside the snapshot and the WASM, not after them.
  const [, , makerTooling] = await Promise.all([
    tugbankClient.ready(),
    initTugmark({ module_or_path: wasmUrl }),
    loadMakerTooling(getSettings()),
  ]);

  keyboardAccessStore.initialize(normalizeKeyboardAccessMode(readKeyboardAccess(tugbankClient)));
  keymapOverrideStore.initialize(tugbankClient.readDomain(KEYMAP_DOMAIN));
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

  window.__tugBridge = window.__tugBridge ?? {};
  window.__tugBridge.onBodyBind = (bind: BodyBind) => {
    void bindBody(bind);
  };
  // The host is about to carry this card's box to a new size: pin every
  // preserve scroller across it, as the shell's own crossing does for an
  // in-document card, and only then tell the host it may set the final
  // size — the host's resize would race the pin otherwise. The host calls
  // this in the task it runs the plan in, so the pin costs one hop to this
  // page and one back, inside a display period. The land ends the episode,
  // which is the restore.
  //
  // The acknowledgement carries the page's own surface as sRGB bytes: the
  // host paints the container in it for the crossing, so where a shrinking
  // box is still larger than the page at its final size the strip the page
  // does not reach is the body's surface, never the floor beneath.
  let crossing: ResizeEpisodeHandle | null = null;
  window.__tugBridge.onBodyCrossing = (next: BodyCrossing) => {
    crossing?.end();
    crossing = null;
    if (next.phase !== "begin") return;
    const root = document.getElementById("deck-container") ?? document.body;
    crossing = beginResizeEpisode(root, next.durationMs ?? 0);
    postToHost("crossingReady", { surface: pageSurfaceRgba() });
  };
  postToHost("bodyHello", {});
})();
