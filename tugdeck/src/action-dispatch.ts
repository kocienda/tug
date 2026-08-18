/**
 * Action dispatcher for incoming Control frames.
 *
 * Implements a Map-based action registry where handlers can be registered
 * and dispatched based on the action string in Control frame payloads.
 *
 * ## Commands fork out; data frames stay
 *
 * `dispatchAction` reads the frame and forks once ([P03]). A wire naming a
 * `command-registry.ts` entry is a user-invocable command and goes to
 * `dispatchCommand`, which reads how to route it from the table. Every
 * other wire is a tugcast data frame — `spawn_session_ok`,
 * `session_updated`, `app-lifecycle`, `eval`, `ask` and their siblings —
 * and resolves through the `registerAction` handler map below.
 *
 * The handler map is also the `registry` routing target: a command whose
 * body lives here (rather than on a responder) is registered exactly as
 * before, and `dispatchCommand` reaches it through `getRegistryHandler`.
 *
 * See `tuglaws/action-naming.md` for the naming convention.
 */

import type { TugConnection } from "./connection";
import type { DeckManager } from "./deck-manager";
import type { ResponderChainManager } from "./components/tugways/responder-chain";
import { FeedId } from "./protocol";
import { BASE_THEME_NAME } from "./theme-constants";
import { transferFocusForActivation } from "./focus-transfer";
import { toggleSidebarCard } from "./sidebar-toggle";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { COMMANDS_BY_ID, isCommandId } from "@/components/tugways/command-registry";
import { advanceKeyViewFocus, getFocusManager, BASE_FOCUS_MODE } from "@/components/tugways/focus-manager";
import { dispatchCommand } from "./command-dispatch";
import { openDiffInCard } from "@/lib/open-diff-in-card";
import { neighborSlot } from "@/lib/neighbor-slot";
import { flashCardPane, flashPaneBorder } from "@/lib/flash-pane-border";
import { isDiffDescriptor } from "@/lib/git-diff-store";
import {
  isContentWidth,
  isImpositionKind,
  isRailMode,
  isSidebarSide,
} from "@/lib/layout-imposer";
import { JOTS_CARD_ID } from "@/lib/jots-card-id";
import { LENS_CARD_ID } from "@/lib/lens-card-id";
import { OVERVIEW_CARD_ID } from "@/lib/overview-card-id";
import { PERMISSION_MODE_CYCLE } from "./lib/permission-mode";
import {
  cardIdForSession,
  cardSessionBindingStore,
} from "./lib/card-session-binding-store";
import { dashBindErrorStore } from "./lib/dash-bind-error-store";
import { sessionNameStore } from "./lib/session-name-store";
import { sessionTagStore } from "./lib/session-tag-store";
import { sessionPrivateStore } from "./lib/session-private-store";
import { sessionSynopsisStore } from "./lib/session-synopsis-store";
import { sessionCitationStore } from "./lib/session-citation-store";
import { applyAuthResultPayload, applyInstallResultPayload, applyLogoutResultPayload } from "./lib/auth-store";
import {
  applyVersionResultPayload,
  applyUpdateResultPayload,
} from "./lib/claude-version-store";
import { requestLogout } from "./lib/logout-store";
import { requestConfigureTug } from "./lib/configure-tug-request-store";
import { sessionSpawnErrorStore } from "./lib/session-spawn-error-store";
import { fireRestore, notifySpawnRejected } from "./lib/session-restore";
import { appInfoStore } from "./lib/app-info-store";
import { logSessionLifecycle } from "./lib/session-lifecycle-log";
import { getAppLifecycle } from "./lib/app-lifecycle";
import { keyboardAccessStore } from "./keyboard-access-store";
import {
  decodeResolveSessionsOk,
  decodeSessionUpdated,
  normalizeSessionRow,
} from "./protocol";
import type {
  CardBinding,
  OverviewPostWire,
  PulseLineWireRow,
  SessionStateChangeWireRow,
} from "./protocol";
import { publishListPulseLinesOk } from "./lib/pulse-store";
import { publishListOverviewPostsOk } from "./lib/overview-store";
import { cardServicesStore } from "./lib/card-services-store";
import { pendingAskStore } from "./lib/pending-ask-store";
import { applyRestoredRefs } from "./lib/refs-session-store";
import { applyRestoredShellExchanges } from "./lib/shell-session-store";
import {
  publishSessionUpdated,
  publishListSessionsOk,
  publishListSessionsProgress,
  publishListSessionsErr,
  publishListCardBindingsOk,
  publishListCardBindingsErr,
  publishTrashSessionOk,
  publishTrashSessionErr,
  publishTrashProjectDirSessionsOk,
  publishTrashProjectDirSessionsErr,
  publishListSessionStateChangesOk,
  publishListSessionStateChangesErr,
} from "./lib/session-ledger-events";

/**
 * Ordered list of all shipped themes.
 * Must stay in sync with tugdeck/styles/themes/*.css plus the base theme.
 * Base theme always comes first. The remainder are grouped by mode — the dark
 * themes, then the light themes — so the `next-theme` cycle sweeps through all
 * darks before all lights instead of ping-ponging between modes.
 */
export const SHIPPED_THEME_NAMES: readonly string[] = [
  BASE_THEME_NAME, // brio (dark)
  "nocturne", // dark
  "bravura", // dark
  "harmony", // light
  "aria", // light
  "vivace", // light
];

/** Handler function for an action */
export type ActionHandler = (payload: Record<string, unknown>) => void;

/** Map of action names to handler functions */
const handlers = new Map<string, ActionHandler>();

/** Module-level flag to prevent duplicate reload calls */
let reloadPending = false;

/**
 * Whether the current `accessibility` keyboard-access mode was flipped on
 * by VoiceOver detection (vs. persisted by the user). VoiceOver turning
 * off undoes only a detection-driven flip.
 */
let voiceOverDroveAccessibility = false;

/** Module-level reference to the theme setter, populated by TugThemeProvider on mount. */
let themeSetterRef: ((theme: string) => void) | null = null;

/** Module-level reference to the theme getter, populated by TugThemeProvider on mount. */
let themeGetterRef: (() => string) | null = null;

/**
 * Module-level reference to the ResponderChainManager, populated by
 * ResponderChainProvider on mount via `registerResponderChainManager`.
 *
 * Used by the `add-card-to-active-pane` and `show-component-gallery` Control-frame actions
 * to dispatch through the responder chain, which routes them to DeckCanvas's
 * registered handlers.
 *
 * [D06] Add-tab action uses DeckManager + responder chain
 * [D09] Add-tab routed as DeckCanvas responder action
 */
let responderChainManagerRef: ResponderChainManager | null = null;

/**
 * Register the theme setter function from TugThemeProvider.
 * Called by TugThemeProvider on mount so the set-theme action handler
 * can call it when a Theme submenu item is selected.
 */
export function registerThemeSetter(setter: (theme: string) => void): void {
  themeSetterRef = setter;
}

/**
 * Get the registered theme setter (used by the set-theme action handler).
 * Returns null if TugThemeProvider has not yet mounted.
 */
export function getThemeSetter(): ((theme: string) => void) | null {
  return themeSetterRef;
}

/**
 * Register the theme getter function from TugThemeProvider.
 * Called by TugThemeProvider on mount so the next-theme action handler
 * can read the current theme name.
 */
export function registerThemeGetter(getter: () => string): void {
  themeGetterRef = getter;
}

/**
 * Get the registered theme getter (used by the next-theme action handler).
 * Returns null if TugThemeProvider has not yet mounted.
 */
export function getThemeGetter(): (() => string) | null {
  return themeGetterRef;
}

/**
 * Register the ResponderChainManager from ResponderChainProvider.
 * Called by ResponderChainProvider on mount so the `add-tab` and
 * `show-component-gallery` action handlers can dispatch through the chain.
 *
 * Last-registration-wins: calling again replaces the previous manager.
 *
 * [D06] Add-tab action uses DeckManager + responder chain
 */
export function registerResponderChainManager(manager: ResponderChainManager): void {
  responderChainManagerRef = manager;
}

/**
 * Get the registered ResponderChainManager, or `null` if
 * `ResponderChainProvider` has not mounted (standalone gallery use,
 * unit tests, the brief pre-mount window).
 *
 * Lets non-React modules — e.g. the CM6 caret layer's dev-only
 * focus/first-responder invariant probe — read first-responder state
 * without threading the manager through React context.
 */
export function getResponderChainManager(): ResponderChainManager | null {
  return responderChainManagerRef;
}

/** TextDecoder for UTF-8 payload decoding */
const textDecoder = new TextDecoder();

/**
 * Register an action handler.
 *
 * A handler whose name is a *chain-routed* registry command would be
 * unreachable from the wire — the fork in {@link dispatchAction} reroutes
 * such frames through `dispatchCommand`, which dispatches into the chain
 * and never consults this map. Registration is runtime, so no static lint
 * can see the collision; this warning is where it surfaces.
 */
export function registerAction(action: string, handler: ActionHandler): void {
  const routing = COMMANDS_BY_ID.get(action)?.routing;
  if (routing !== undefined && routing !== "registry") {
    console.warn(
      `registerAction: "${action}" is a ${routing}-routed command; control frames named this will never reach this handler`,
    );
  }
  handlers.set(action, handler);
}

/**
 * The handler registered for an action, or `undefined`.
 *
 * This is the `registry` routing target: `dispatchCommand` reaches a
 * command whose body lives here without importing `initActionDispatch`.
 */
export function getRegistryHandler(action: string): ActionHandler | undefined {
  return handlers.get(action);
}

/**
 * Reset handler registry and module state for test isolation.
 * Internal/test-only -- must never be called from production code.
 */
export function _resetForTest(): void {
  handlers.clear();
  reloadPending = false;
  voiceOverDroveAccessibility = false;
  themeSetterRef = null;
  themeGetterRef = null;
  responderChainManagerRef = null;
}

/**
 * Dispatch an action to its registered handler.
 */
export function dispatchAction(payload: Record<string, unknown>): void {
  const action = payload.action;
  if (typeof action !== "string") {
    // Server error frames are CONTROL frames shaped
    // `{ type: "error", detail: "..." }` with no `action` field —
    // they are RPC error responses (e.g. a `spawn_session` rejected
    // with `session_live_elsewhere` / `session_unknown`), not
    // dispatchable actions. Surface them as errors carrying the
    // detail rather than swallowing them as a generic "missing
    // action field" warning, so a failed session restore is
    // diagnosable instead of silent.
    if (payload.type === "error") {
      const detail =
        typeof payload.detail === "string" ? payload.detail : "(no detail)";
      console.error(
        `dispatchAction: server error frame — ${detail}`,
        payload,
      );
      return;
    }
    console.warn("dispatchAction: payload missing action field", payload);
    return;
  }

  // The one fork ([P03]): a wire that names a registry command is a
  // command and goes through the funnel, which reads its routing from the
  // table. Everything else is a tugcast data frame — protocol, not intent —
  // and resolves through the handler map exactly as it always has.
  if (isCommandId(action)) {
    dispatchCommand(action, payload);
    return;
  }

  const handler = handlers.get(action);
  if (handler) {
    handler(payload);
  } else {
    console.warn(`dispatchAction: unknown action: ${action}`, payload);
  }
}

/**
 * Initialize action dispatch system.
 *
 * Registers a callback for Control frames and registers all built-in
 * handlers. Returns a disposer that unsubscribes any lifecycle
 * subscriptions installed here (currently the save-on-resign
 * subscription on `AppLifecycle`); callers that never tear the wiring
 * down can ignore the return value. Production does not call the
 * disposer; tests that re-initialize the action-dispatch wiring
 * should.
 *
 * The Control-frame `onFrame` unsubscribe is registered into the
 * disposer set like every other acquisition ([L27]).
 */
export function initActionDispatch(
  connection: TugConnection,
  deckManager: DeckManager
): () => void {
  // Register Control frame callback; its unsubscribe joins `disposers`
  // below so the teardown fully unwires it ([L27]).
  const controlUnsub = connection.onFrame(FeedId.CONTROL, (payload: Uint8Array) => {
    try {
      const json = textDecoder.decode(payload);
      const data = JSON.parse(json) as Record<string, unknown>;
      dispatchAction(data);
    } catch (error) {
      console.error("initActionDispatch: failed to parse Control frame", error);
    }
  });

  // Register built-in handlers

  // eval: run a expression in the deck and hand the value back on
  // `eval-response`, keyed by the request id tugcast is blocking on.
  //
  // This is the seam `POST /api/eval` drives, and it is how a live instance can
  // be inspected and driven from outside — reading a store's real snapshot,
  // submitting a turn, checking what a surface actually rendered. tugcast has
  // always had its half (`eval_handler` in `server.rs`, `"eval-response"` in
  // `actions.rs`); without this handler the request went out and nothing ever
  // answered, so every call died on the 30s timeout.
  //
  // ask: a process outside the turn stream wants the developer's consent before
  // it does something disruptive. Unlike `eval` (below), this is NOT dev-gated —
  // it displays text and returns one of the caller's own option ids, and a
  // consent prompt that only works on a dev build is no consent prompt. tugcast
  // clamps the caller's text and option count instead, since it gave up the gate.
  //
  // The caller is blocked on the answer, so the store answers on every path
  // out, including "there is no session to show this on".
  registerAction("ask", (payload) => {
    pendingAskStore.receive(payload);
  });

  // The other end of `ask`'s lifecycle: tugcast resolved the question itself
  // (its timeout elapsed), so the dialog comes down without an answer frame.
  registerAction("ask-rescind", (payload) => {
    const requestId = payload.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) return;
    pendingAskStore.rescind(requestId);
  });

  // Gated twice on the tugcast side before an `eval` frame is ever broadcast:
  // loopback callers only, and dev mode only. A release instance answers
  // `forbidden` without consulting the deck at all.
  registerAction("eval", (payload) => {
    const requestId = payload.requestId;
    const code = payload.code;
    if (typeof requestId !== "string" || typeof code !== "string") return;
    let result: unknown;
    try {
      // Indirect eval — the value is evaluated in global scope, so the code
      // sees `window` and the module singletons rather than this closure.
      result = (0, eval)(code);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    const reply = (value: unknown): void => {
      // The frame is JSON, so the answer has to survive `JSON.stringify`.
      // Anything that won't (a DOM node, a function, a cycle) comes back as
      // its String form rather than silently becoming null.
      let encoded: unknown = value;
      try {
        JSON.stringify(value);
      } catch {
        encoded = String(value);
      }
      connection.sendControlFrame("eval-response", {
        requestId,
        result: encoded ?? null,
      });
    };
    // A promise is awaited before answering, so `await`-shaped probes work.
    if (result instanceof Promise) {
      result.then(reply, (error: unknown) => {
        reply({ error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    reply(result);
  });

  // claude_auth_result: tugcast's answer to `check_auth` (probe) and
  // `claude_sign_in` (login). Updates the app-level authStore that the
  // app-wide sign-in sheet, the picker gate, and the per-card banner all read.
  registerAction("claude_auth_result", (payload) => {
    applyAuthResultPayload(payload);
  });

  // claude_install_result: outcome of a Tug-managed `install_claude` (the
  // re-probe arrives separately as claude_auth_result).
  registerAction("claude_install_result", (payload) => {
    applyInstallResultPayload(payload);
  });

  // claude_version_result: tugcast's answer to `check_claude_version` — the
  // installed version and the newest stable release. Also re-broadcast after an
  // install or update, so the row settles on what actually landed.
  registerAction("claude_version_result", (payload) => {
    applyVersionResultPayload(payload);
  });

  // claude_update_result: outcome of a Tug-managed `update_claude` (the
  // re-probe arrives separately as claude_version_result).
  registerAction("claude_update_result", (payload) => {
    applyUpdateResultPayload(payload);
  });

  // claude_logout_result: outcome of `claude_logout` (the re-probe arrives
  // separately as claude_auth_result). On failure this carries the error the
  // TugLogout orchestrator surfaces.
  registerAction("claude_logout_result", (payload) => {
    applyLogoutResultPayload(payload);
  });

  // logout: app-level "Log out…" trigger from the File menu (like show-card,
  // not the per-card run-card-command — logout must work with no card open).
  // Bumps the logout-request nonce; TugLogout runs the confirm → logout flow.
  registerAction("logout", () => {
    requestLogout();
  });

  // setup: app-level "Configure Tug…" trigger from the Tug menu. Bumps the
  // configure-tug-request nonce; ConfigureTugRequest stops any live turns and then opens
  // the wizard on demand.
  registerAction("configure-tug", () => {
    requestConfigureTug();
  });

  // reload: Reload page with dedup guard.
  // prepareForReload() saves+flushes with a normal fetch and sets reloadPending
  // on DeckManager so the beforeunload handler skips the redundant keepalive
  // flush (which fails in WKWebView during page navigation with CORS errors).
  registerAction("reload", () => {
    if (reloadPending) return;
    reloadPending = true;
    deckManager.prepareForReload().then(() => {
      location.reload();
    });
  });

  // set-theme: Switch the active theme via TugThemeProvider.
  // Accepts any string theme name — validation is delegated to the theme provider,
  // which fetches CSS via middleware and handles 404s gracefully. [D07]
  // The Swift AppDelegate sends this action from the Theme submenu.
  registerAction("set-theme", (payload) => {
    const theme = payload.theme;
    if (typeof theme !== "string") {
      console.warn("set-theme: invalid theme", payload);
      return;
    }
    if (themeSetterRef) {
      themeSetterRef(theme);
    } else {
      console.warn("set-theme: theme setter not registered yet");
    }
  });

  // next-theme: Advance to the next shipped theme (wrapping around).
  // Uses SHIPPED_THEME_NAMES to determine order and the registered themeGetterRef to
  // read the current theme. Falls back to the base theme if the getter is not yet
  // registered or the current theme is not in the shipped list.
  registerAction("next-theme", () => {
    const currentTheme = themeGetterRef ? themeGetterRef() : SHIPPED_THEME_NAMES[0];
    const idx = SHIPPED_THEME_NAMES.indexOf(currentTheme);
    const nextIdx = idx === -1 ? 0 : (idx + 1) % SHIPPED_THEME_NAMES.length;
    const nextTheme = SHIPPED_THEME_NAMES[nextIdx];
    if (themeSetterRef) {
      themeSetterRef(nextTheme);
    } else {
      console.warn("next-theme: theme setter not registered yet");
    }
  });

  // source-tree: Call WKScriptMessageHandler bridge if available
  registerAction("source-tree", () => {
    console.info("source-tree: triggering source tree picker");

    const webkit = (globalThis as unknown as Record<string, unknown>).webkit as Record<string, unknown> | undefined;
    const messageHandlers = webkit?.messageHandlers as Record<string, unknown> | undefined;
    if (messageHandlers?.sourceTree) {
      (messageHandlers.sourceTree as { postMessage: (v: unknown) => void }).postMessage({});
    } else {
      console.info("source-tree: WKScriptMessageHandler bridge not available");
    }
  });

  // toggle-lens / toggle-jots / toggle-overview: the three-state sidebar
  // shortcut — show-and-activate, activate, hide ({@link toggleSidebarCard}).
  // Fired by the Swift menu's "Show Lens" (⌃⌘L), "Show Jots" (⌃⌘J), and "Show
  // Overview" (⌃⌘O) items and the browser-dev keybindings; the deck-canvas key
  // handlers run the same performer.
  registerAction("toggle-lens", () => {
    toggleSidebarCard(deckManager, LENS_CARD_ID);
  });

  registerAction("toggle-jots", () => {
    toggleSidebarCard(deckManager, JOTS_CARD_ID);
  });

  registerAction("toggle-overview", () => {
    toggleSidebarCard(deckManager, OVERVIEW_CARD_ID);
  });

  // next/previous-keyboard-focus: move the keyboard focus ring one stop, the
  // View menu's face for what ⇥ / ⇧⇥ do. Both doors run the one performer.
  registerAction(TUG_ACTIONS.NEXT_KEYBOARD_FOCUS, () => {
    advanceKeyViewFocus(getFocusManager(), 1);
  });
  registerAction(TUG_ACTIONS.PREVIOUS_KEYBOARD_FOCUS, () => {
    advanceKeyViewFocus(getFocusManager(), -1);
  });

  // cycle-focus-mode: the ⌥⇥ gesture. It acts on whatever owns the keyboard
  // RIGHT NOW, which is the focus mode — not on whichever card is frontmost.
  //
  // At the base mode the key card is asked first, because a card with a cycle
  // scope wants the toggle at its own responder: the session card pushes its
  // cycle mode and seeds its commit-home there. A card that registers no
  // handler (the Lens, a diff card, anything Class-B) reports unhandled, and
  // the deck-level meaning below stands in — flip the bit, seed a ring.
  //
  // While a floating surface holds a trapped mode, the key card is the WRONG
  // target and asking it is actively destructive. The card behind the surface
  // answers, enters its own cycle, and moves the key view into itself; DOM
  // focus lands somewhere that is neither inside the floating panel nor on the
  // engine key sink, and the surface's own blur-dismiss closes it. The gesture
  // then reads as "⌥⇥ makes Open Quickly disappear". So a non-base mode never
  // consults the card: the toggle applies to the mode that is up, and the ring
  // seeds among ITS stops.
  //
  // It lives on the command rather than in the key pipeline because ⌥⇥ is not
  // the only door. The View menu item and the palette dispatch the same
  // command id, and a tier sited at one door is a gesture that works from that
  // door alone.
  registerAction(TUG_ACTIONS.CYCLE_FOCUS_MODE, () => {
    const focusManager = getFocusManager();
    if (focusManager === null) return;
    if (focusManager.currentFocusMode() === BASE_FOCUS_MODE) {
      const chain = getResponderChainManager();
      const result = chain?.sendToKeyCardForContinuation({
        action: TUG_ACTIONS.CYCLE_FOCUS_MODE,
        phase: "discrete",
      });
      result?.continuation?.();
      if (result?.handled === true) return;
    }
    if (focusManager.toggleKbfManual()) focusManager.seedKbfRing();
  });

  // set-imposition: choose the deck's N-up arrangement, or turn it off.
  // Dispatched by the Lens Layouts section's kind picker. `kind: null` clears
  // it, freezing every imposed pane where the user last saw it.
  registerAction("set-imposition", (payload) => {
    const kind = payload.kind;
    if (kind !== null && !isImpositionKind(kind)) {
      console.warn("set-imposition: missing or invalid kind", payload);
      return;
    }
    deckManager.setImposition(kind);
  });

  // set-card-width: set one content pane's width to a named preset. Dispatched
  // by the pane title bar's width popup, which addresses the pane by id rather
  // than relying on which card is focused — the popup you opened is the pane
  // you meant.
  registerAction(TUG_ACTIONS.SET_CARD_WIDTH, (payload) => {
    const paneId = payload.paneId;
    const preset = payload.preset;
    if (typeof paneId !== "string" || !isContentWidth(preset)) {
      console.warn("set-card-width: missing or invalid paneId/preset", payload);
      return;
    }
    deckManager.setPaneWidth(paneId, preset);
  });

  // set-bullseye: put one named pane in bullseye, or take it out when it is
  // already there. Dispatched by the pane title bar's target button, which
  // addresses the pane by id — the button you pressed is the pane you meant —
  // and by `toggle-bullseye` once the canvas has resolved which pane the
  // selection is in. Rails included: a rail's place on the edge is reserved
  // while it holds the posture, so it returns to it on exit.
  registerAction(TUG_ACTIONS.SET_BULLSEYE, (payload) => {
    const paneId = payload.paneId;
    if (typeof paneId !== "string") {
      console.warn("set-bullseye: missing or invalid paneId", payload);
      return;
    }
    deckManager.toggleBullseye(paneId);
  });

  // set-content-width: choose the width content cards read at across the whole
  // deck. Dispatched by the Lens Layouts section's width picker. It lands on
  // every content pane at once, which is what makes it the deck's width rather
  // than a seed for the next card the user opens.
  registerAction(TUG_ACTIONS.SET_CONTENT_WIDTH, (payload) => {
    const preset = payload.preset;
    if (!isContentWidth(preset)) {
      console.warn("set-content-width: missing or invalid preset", payload);
      return;
    }
    deckManager.setContentWidth(preset);
  });

  // set-sidebar-side: choose the side of the deck a sidebar card holds — the
  // other axis of the imposition. Dispatched by the Lens Layouts section, one
  // control per registered sidebar card.
  registerAction(TUG_ACTIONS.SET_SIDEBAR_SIDE, (payload) => {
    const componentId = payload.componentId;
    const side = payload.side;
    if (typeof componentId !== "string" || !isSidebarSide(side)) {
      console.warn(
        "set-sidebar-side: missing or invalid componentId/side",
        payload,
      );
      return;
    }
    deckManager.setSidebarSide(componentId, side);
  });

  // set-rail-mode: stack or split one side's rail. Dispatched by the title
  // bar's stack badge menu and by the Lens Layouts section's per-side rail row.
  // A side is a stack or a split — all of its visible members participate,
  // which is why the payload names a side rather than a pair of cards.
  registerAction(TUG_ACTIONS.SET_RAIL_MODE, (payload) => {
    const side = payload.side;
    const mode = payload.mode;
    if (!isSidebarSide(side) || !isRailMode(mode)) {
      console.warn("set-rail-mode: missing or invalid side/mode", payload);
      return;
    }
    deckManager.setRailMode(side, mode);
  });

  // equalize-rail: divide a split rail's run equally again. Dispatched by the
  // stack badge menu and by a double-click on the seam. The side's mode and
  // member order survive — only the heights a seam drag set are discarded.
  registerAction(TUG_ACTIONS.EQUALIZE_RAIL, (payload) => {
    const side = payload.side;
    if (!isSidebarSide(side)) {
      console.warn("equalize-rail: missing or invalid side", payload);
      return;
    }
    deckManager.equalizeRail(side);
  });

  // assign-slot: put a card's pane at a numbered position in the active
  // imposition. Dispatched by ⌘1..⌘9 on the deck canvas and by the `SlotPicker`
  // cluster on Lens Sessions and Text Files rows. `slot` is 0-based (the
  // buttons render 1-based).
  //
  // The assignment always flashes the card's pane, including when the card was
  // already in the slot the caller named. A chord that lands on the slot the
  // frontmost card already holds moves nothing, and without the flash it is
  // indistinguishable from a chord that did not land at all — so the flash is
  // the gesture's receipt, not a decoration on the motion ([P04], [L06]).
  registerAction("assign-slot", (payload) => {
    const cardId = payload.cardId;
    if (typeof cardId !== "string") {
      console.warn("assign-slot: missing or invalid cardId", payload);
      return;
    }
    const slot = payload.slot;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0) {
      console.warn("assign-slot: missing or invalid slot", payload);
      return;
    }
    deckManager.assignCardToSlot(cardId, slot);
    // Read the pane back AFTER the call: a card pulled out of a tab group
    // lands in a pane that did not exist before it. `slot` being set is what
    // separates an assignment that happened from one `assignCardToSlot`
    // refused (no imposition, sidebar host) — a refusal must not flash.
    const landed = deckManager
      .getSnapshot()
      .panes.find((p) => p.cardIds.includes(cardId));
    if (landed?.slot !== undefined) flashPaneBorder(landed.id);
  });

  // focus-session-card: activate a specific card (front its pane + promote the
  // responder chain) and flash its title bar once. Dispatched by a Lens
  // Sessions monitor row on click ([P04]). Like `focus-pane` it routes through
  // `transferFocusForActivation` so the activation fires the full
  // will/didDeactivate + will/didActivate transition; the flash is pure
  // appearance (a CSS class toggled on the pane header DOM, removed on
  // `animationend`), never React state ([L06]).
  registerAction("focus-session-card", (payload) => {
    const cardId = payload.cardId;
    if (typeof cardId !== "string") {
      console.warn("focus-session-card: missing or invalid cardId", payload);
      return;
    }
    const pane = deckManager
      .getSnapshot()
      .panes.find((p) => p.cardIds.includes(cardId));
    if (!pane) {
      console.warn(`focus-session-card: no pane holds card "${cardId}"`);
      return;
    }
    transferFocusForActivation({
      outgoingCardId: deckManager.getFirstResponderCardId(),
      incomingCardId: cardId,
      store: deckManager,
      commitMutation: () => deckManager.activateCard(cardId),
    });
    flashPaneBorder(pane.id);
  });

  // resume-session: open a fresh session card and restore a session into it.
  // The counterpart of `focus-session-card` for a session no card holds —
  // dispatched by the session identity menu, whose one item reads "Show
  // Session" or "Resume Session" depending on which of the two applies.
  //
  // The card is created first and restored into second, which is the same
  // order startup restore uses ([L27] disposal aside): `fireRestore` only
  // needs a card id to key its expectation on, and the card mounts on the
  // restoring placeholder because the registry entry is what that placeholder
  // reads.
  //
  // Placement follows the file-link rule ({@link neighborSlot}): the resumed
  // session lands in the slot beside the card whose menu named it — left when
  // there is a left, right when there is not. `originCardId` is the menu's
  // host card, which is the card the reader is pointing at even when the
  // right-click has not moved first responder; the first responder is the
  // fallback for a dispatch that names no origin.
  registerAction(TUG_ACTIONS.RESUME_SESSION, (payload) => {
    const sessionId = payload.sessionId;
    const projectDir = payload.projectDir;
    if (typeof sessionId !== "string" || typeof projectDir !== "string") {
      console.warn("resume-session: missing sessionId or projectDir", payload);
      return;
    }
    const outgoing = deckManager.getFirstResponderCardId();
    const origin =
      typeof payload.originCardId === "string" ? payload.originCardId : null;
    // The named host first, the first responder second: a menu mounted in a
    // rail — the Overview, the Lens — names a card that holds no slot of its
    // own and so has no neighbour to offer, and the reader's focused card is
    // the better answer than the head of the arrangement.
    const slot =
      neighborSlot(deckManager, origin) ?? neighborSlot(deckManager, outgoing);
    // Save-before-activation ([L23]): `addCard` activates the fresh card
    // directly, so the surface that dispatched this — the identity row's
    // menu, mounted in some other card — must bank its focus bag first.
    if (outgoing !== null) deckManager.invokeSaveCallback(outgoing);
    const cardId = deckManager.addCard("session", undefined, { slot });
    if (cardId === null) {
      console.warn("resume-session: no session card registration");
      return;
    }
    // The same ring a raise draws, for the same reason: the answer to the
    // gesture is a card somewhere else on the deck, and the eye has to be
    // told where ([P04]).
    flashCardPane(deckManager, cardId);
    fireRestore(cardId, sessionId, projectDir, connection);
  });

  // show-card: Show a card by componentId. The Swift app menu sends
  // show-card for "settings" / "about" (app-level singletons), for
  // "spike-home" (the Spikes index, a debug-build Maker item), and for
  // "dev" (New Session Card, ⌘N). Singleton components reuse an existing
  // card of that type (raising it to z-top) instead of spawning a
  // duplicate; every other component — notably "dev" — adds a fresh
  // card each time, so ⌘N always opens a new session card. The about
  // invocation additionally carries the app's build identity (version,
  // build, commit, branch, profile, copyright), parked in appInfoStore
  // for the About card to read.
  //
  // The Spikes index is a singleton for the same reason the others are: a
  // second index onto the same list is never the thing anyone wanted.
  const SINGLETON_CARDS = new Set(["about", "settings", "keyboard", "spike-home"]);
  registerAction("show-card", (payload) => {
    const component = payload.component;
    if (typeof component !== "string") {
      console.warn("show-card: missing or invalid component parameter", payload);
      return;
    }
    if (component === "about") {
      appInfoStore.setFromPayload(payload);
    }
    if (SINGLETON_CARDS.has(component)) {
      deckManager.showSingletonCard(component);
    } else {
      deckManager.addCard(component);
    }
  });

  // open-diff: pop a diff descriptor out into a Diff card. Descriptor-keyed
  // reuse — a card already showing the same descriptor is activated;
  // otherwise a new Diff card is created seeded with it. Dispatched by the
  // changeset card's per-file and whole-entry pop-out affordances.
  registerAction(TUG_ACTIONS.OPEN_DIFF, (payload) => {
    const descriptor = payload.descriptor;
    if (!isDiffDescriptor(descriptor)) {
      console.warn("open-diff: missing or invalid descriptor", payload);
      return;
    }
    openDiffInCard(deckManager, descriptor);
  });


  // ---- Parameterized menu wires ----
  //
  // Three Swift selectors carry their parameter in the frame rather than
  // in the wire name. Each resolves that parameter to the per-value
  // registry entry ([P05]) and hands off to the funnel, so a menu item and
  // a future keymap row reach the same command by the same path.

  // run-card-command: a Session/File/Edit/Help menu item carrying a local
  // slash-command name (`payload.name`, optional `payload.args`). The
  // command it names re-enters the session card's RUN_SLASH_COMMAND
  // surface map key-card-scoped — byte-identical to typing the command.
  registerAction("run-card-command", (payload) => {
    const name = payload.name;
    if (typeof name !== "string") {
      console.warn("run-card-command: missing or invalid name parameter", payload);
      return;
    }
    const args = typeof payload.args === "string" ? payload.args : "";
    // A bridged item's args are always empty; a caller that supplies them
    // is asking for something no entry's static payload can express, so it
    // dispatches the action directly rather than through the entry.
    if (args === "") {
      const id = `${TUG_ACTIONS.RUN_SLASH_COMMAND}:${name}`;
      if (isCommandId(id)) {
        dispatchCommand(id);
        return;
      }
    }
    // An unknown name still reaches the card, whose surface-map lookup is
    // defensive — a no-op rather than a dead menu item.
    if (responderChainManagerRef) {
      responderChainManagerRef.sendToKeyCard({
        action: TUG_ACTIONS.RUN_SLASH_COMMAND,
        value: { name, args },
        phase: "discrete",
      });
    } else {
      console.warn("run-card-command: responder chain manager not registered yet");
    }
  });

  // set-pane-width: the Window ▸ Slim / Comfy / Wide round-trip. The bare
  // wire name carries the preset as a param; the three commands the user
  // actually invokes are the parameterized ids, so this hands off to them
  // rather than reaching `setPaneWidth` itself — same shape as the
  // permission-mode submenu above, and it keeps the chain walk (and the
  // "which pane am I in" answer) on the canvas where the chord lands too.
  registerAction(TUG_ACTIONS.SET_PANE_WIDTH, (payload) => {
    const preset = payload.preset;
    if (!isContentWidth(preset)) {
      console.warn(`${TUG_ACTIONS.SET_PANE_WIDTH}: invalid preset`, payload);
      return;
    }
    dispatchCommand(`${TUG_ACTIONS.SET_PANE_WIDTH}:${preset}`);
  });

  // toggle-bullseye: the Window ▸ Bullseye round-trip. No payload — the
  // command is selection-relative, so the round-trip through
  // `dispatchCommand` is what keeps the "which pane am I in" answer on the
  // canvas, where the chord lands too.
  registerAction(TUG_ACTIONS.TOGGLE_BULLSEYE, () => {
    dispatchCommand(TUG_ACTIONS.TOGGLE_BULLSEYE);
  });

  // spawn_session_ok: the tugcast supervisor echoes the
  // canonical workspace_key back via this CONTROL ack after a successful
  // spawn_session (). The handler populates
  // `cardSessionBindingStore` so `useCardWorkspaceKey(cardId)` returns
  // the exact string tugcast splices into FILETREE/FILESYSTEM/GIT
  // frames, enabling the per-card value-check filter in `TugPane`.
  //
  // Tugdeck does NOT canonicalize the path client-side — the canonical
  // form includes macOS firmlink resolution that JS path libraries
  // don't match. The server-provided `workspace_key` is the single
  // source of truth for filter identity.
  registerAction("spawn_session_ok", (payload) => {
    const cardId = payload.card_id;
    const tugSessionId = payload.tug_session_id;
    const workspaceKey = payload.workspace_key;
    const projectDir = payload.project_dir;
    const sessionMode = payload.session_mode;
    if (
      typeof cardId !== "string" ||
      typeof tugSessionId !== "string" ||
      typeof workspaceKey !== "string"
    ) {
      console.warn(
        "spawn_session_ok: missing or invalid field in ack payload",
        payload,
      );
      return;
    }
    // `project_dir` is the pre-canonical path the client sent in
    // `spawn_session`. Tugcast doesn't currently echo it in the ack
    // (only `workspace_key`), so fall back to the canonical form when
    // the ack omits it. The binding's `projectDir` is informational —
    // the filter uses `workspaceKey`.
    const projectDirResolved =
      typeof projectDir === "string" ? projectDir : workspaceKey;
    // Pre-`session_mode` server acks omit the field; default to
    // "new" to match the fresh-by-default behavior elsewhere.
    const sessionModeResolved =
      sessionMode === "resume" ? "resume" : "new";
    logSessionLifecycle("spawn.ack", {
      card_id: cardId,
      tug_session_id: tugSessionId,
      workspace_key: workspaceKey,
      project_dir: projectDirResolved,
      session_mode: sessionModeResolved,
    });
    // The dash this session is working on rides the ack beside
    // `workspace_key`, and the server has already nulled it when the dash's
    // branch is gone — so an absent pair is simply "not mated".
    const ackDashId = typeof payload.dash_id === "string" ? payload.dash_id : null;
    const ackDashName =
      typeof payload.dash_name === "string" ? payload.dash_name : null;
    cardSessionBindingStore.setBinding(cardId, {
      tugSessionId,
      workspaceKey,
      projectDir: projectDirResolved,
      sessionMode: sessionModeResolved,
      dash:
        ackDashId && ackDashName
          ? { id: ackDashId, name: ackDashName }
          : undefined,
    });
    // Seed the chip's name/tag caches straight off the bind ack so a bound
    // card shows its identity immediately — never stranded on the id-hash
    // waiting for a later frame. A mid-turn resume binds via this ack alone:
    // `session_updated` only fires at turn boundaries, so without this the
    // chip sits on the hash for the whole in-flight turn even though the
    // ledger holds a good name/tag. Non-clobbering (`seed*`): a fresh spawn's
    // ack carries no row yet, and its `null`s must not wipe the optimistic
    // tag `provisionSpawnTag` already set. The ledger stays authoritative via
    // the later `session_updated` push.
    const ackName = typeof payload.name === "string" ? payload.name : null;
    const ackNameUserSet = payload.name_user_set === true;
    const ackTag = typeof payload.tag === "string" ? payload.tag : null;
    const ackSynopsis =
      typeof payload.synopsis === "string" ? payload.synopsis : null;
    sessionNameStore.seedName(tugSessionId, ackNameUserSet ? ackName : null);
    sessionTagStore.seedTag(tugSessionId, ackTag);
    // The description is the second half of the identity's description line;
    // it seeds beside the name for the same reason (a resume binds via this
    // ack alone).
    sessionSynopsisStore.seedSynopsis(tugSessionId, ackSynopsis);
    // Privacy is authoritative on the ack too: the row is read fresh, and a
    // resumed card must show the marker without waiting for a later push.
    sessionPrivateStore.setPrivate(tugSessionId, payload.private === true);
  });

  // bind_dash_ok / unbind_dash_ok: a session's dash mating changed while the
  // card is open — a skill running `tugutil dash bind`, or the `dash bind`
  // that follows a `dash create`. The store's record already exists (the
  // spawn ack made it), so this merges the dash half in rather than replacing
  // it: a `setBinding` here would clobber the `workspaceKey` the pane's feed
  // filter is built from. `cardIdForSession` is the reverse walk from the
  // session the broadcast names to the card holding it.
  registerAction("bind_dash_ok", (payload) => {
    const sessionId = payload.tug_session_id;
    const dashId = payload.dash_id;
    const dashName = payload.dash_name;
    if (
      typeof sessionId !== "string" ||
      typeof dashId !== "string" ||
      typeof dashName !== "string"
    ) {
      console.warn("bind_dash_ok: missing or invalid field", payload);
      return;
    }
    // A binding that landed is not still a failure — clear any parked refusal
    // before the notice's next read.
    dashBindErrorStore.clear(sessionId);
    const cardId = cardIdForSession(sessionId);
    if (cardId) {
      cardSessionBindingStore.setDashBinding(cardId, {
        id: dashId,
        name: dashName,
      });
    }
  });

  // bind_dash_err: the mating did not happen. Nothing optimistic was raised —
  // the chip and the lane both wait for `bind_dash_ok` — so a refusal has
  // nothing to put back and would otherwise land in silence. Park it for the
  // card's `DashBindErrorNoticeController` to surface as a bulletin.
  registerAction("bind_dash_err", (payload) => {
    console.warn("bind_dash failed", payload);
    const sessionId = payload.tug_session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    dashBindErrorStore.fail(
      sessionId,
      typeof payload.reason === "string" ? payload.reason : "unknown",
    );
  });

  registerAction("unbind_dash_ok", (payload) => {
    const sessionId = payload.tug_session_id;
    if (typeof sessionId !== "string") return;
    const cardId = cardIdForSession(sessionId);
    if (cardId) cardSessionBindingStore.setDashBinding(cardId, null);
  });

  // session_updated: tugcast supervisor broadcasts these on every
  // ledger write (`record_spawn`, `record_turn`, `mark_closed`,
  // `mark_failed`, `trash`). Routed through the
  // `session-ledger-events` bus so the picker's session-ledger
  // store (step 4) can patch its in-memory cache without re-fetching.
  registerAction("session_updated", (payload) => {
    const decoded = decodeSessionUpdated(payload);
    if (decoded === null) {
      console.warn("session_updated: invalid payload shape", payload);
      return;
    }
    // Keep the Z4B chip's name cache authoritative ([#step-13d]): a rename
    // (or any ledger write) pushes the post-write row. Only a user `/rename`
    // feeds the chip — an auto `aiTitle` (name_user_set false) clears it so the
    // chip falls back to the hash.
    // A trash must reach every identity cache, not just the ledger store: a
    // lingering tag entry would let `/resume <tag>` hand back a trashed
    // session's id, and a lingering citation answer would keep its chips
    // resolvable for the rest of the run.
    if (decoded.removed === true) {
      sessionNameStore.setName(decoded.session_id, null);
      sessionTagStore.setTag(decoded.session_id, null);
      sessionSynopsisStore.setSynopsis(decoded.session_id, null);
      sessionCitationStore.forgetSession(decoded.session_id);
      sessionPrivateStore.forget(decoded.session_id);
    }
    if (decoded.fields !== undefined) {
      sessionNameStore.setName(
        decoded.session_id,
        decoded.fields.name_user_set ? (decoded.fields.name ?? null) : null,
      );
      // Make the optimistic provisional tag authoritative: the echoed row
      // carries the server's claimed-or-suffixed tag (the tag has no user-set
      // gate; it always fronts the session when present). Non-clobbering — a
      // row read before the tag landed carries `null`, which must not wipe the
      // optimistic tag back to the id-hash.
      sessionTagStore.seedTag(decoded.session_id, decoded.fields.tag);
      // The description, unlike the callsign, is authoritative on every push:
      // the Summarize lane rewrites it as the work moves and the ledger row is
      // the only truth, so a push carrying `null` means it really is empty
      // (a rename froze it, or none has been written yet).
      sessionSynopsisStore.setSynopsis(
        decoded.session_id,
        decoded.fields.synopsis,
      );
      // Overview privacy is authoritative on every push: the row is the only
      // truth, and a push carrying `false` means the session really is public.
      sessionPrivateStore.setPrivate(
        decoded.session_id,
        decoded.fields.private === true,
      );
    }
    publishSessionUpdated(decoded);
  });

  // rename_session_ok / _err: the ack for `/rename`. The rename surface writes
  // the chip name optimistically and holds the name it replaced; these arms
  // resolve that waiter, which puts the old name back on a refusal and reports
  // either outcome in the card's bulletin. The name identifies WHICH rename is
  // being acked — CONTROL is a broadcast, and a second rename in flight must
  // not have its outcome spoken by the first one's ack.
  registerAction("rename_session_ok", (payload) => {
    const sessionId = payload.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const name = typeof payload.name === "string" ? payload.name : null;
    sessionNameStore.settle(sessionId, name, { ok: true });
  });
  registerAction("rename_session_err", (payload) => {
    console.warn("rename_session failed", payload);
    const sessionId = payload.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const name = typeof payload.name === "string" ? payload.name : null;
    sessionNameStore.settle(sessionId, name, {
      ok: false,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
    });
  });

  // set_session_private_ok / _err: the ack for `/private`. The command writes
  // the store optimistically so the atom's marker turns over with the gesture;
  // these arms reconcile it with what the ledger actually did. The `_err` arm
  // is why the optimistic write is safe — a refused toggle is put back rather
  // than left showing a state the server never entered.
  registerAction("set_session_private_ok", (payload) => {
    const sessionId = payload.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const written = payload.private === true;
    sessionPrivateStore.setPrivate(sessionId, written);
    sessionPrivateStore.settle(sessionId, written, { ok: true });
  });
  registerAction("set_session_private_err", (payload) => {
    console.warn("set_session_private failed", payload);
    const sessionId = payload.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    // Put back the state the toggle came FROM, which is the negation of what
    // was refused — the command toggles off what the store holds, and a
    // refused write left the ledger where it was. Restoring a fixed `false`
    // would only undo one of the two directions: a refused un-private would
    // leave the deck showing "public" over a session that is still private,
    // and no `session_updated` is coming to correct it, since nothing changed.
    const refused = payload.private === true;
    sessionPrivateStore.setPrivate(sessionId, !refused);
    sessionPrivateStore.settle(sessionId, refused, {
      ok: false,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
    });
  });

  // list_sessions_ok / _err: response to a `list_sessions` request. The
  // store consumer (step 4) resolves its pending workspace fetch with
  // the rows or surfaces the error.
  registerAction("list_sessions_ok", (payload) => {
    const projectDir = payload.project_dir;
    const sessions = payload.sessions;
    if (typeof projectDir !== "string" || !Array.isArray(sessions)) {
      console.warn("list_sessions_ok: missing or invalid fields", payload);
      return;
    }
    // `dir_exists` gates the picker's Open button. Absent (older
    // tugcast) defaults to `true` so the dialog fails open — the
    // spawn-error inline alert is the backstop.
    const dirExists =
      typeof payload.dir_exists === "boolean" ? payload.dir_exists : true;
    // Absent (older tugcast) → `false`: a single-shot response is already
    // the settled union, so the picker shows no scanning indicator.
    const scanning =
      typeof payload.scanning === "boolean" ? payload.scanning : false;
    const rows = (sessions as Parameters<typeof normalizeSessionRow>[0][]).map(
      normalizeSessionRow,
    );
    // Seed the chip's name cache from the listed rows ([#step-13d]) so a bound
    // session renamed in a prior run reads correctly once listed. Only a user
    // `/rename` feeds the chip; an auto `aiTitle` leaves it on the hash.
    for (const row of rows) {
      sessionNameStore.seedName(row.session_id, row.name_user_set ? row.name : null);
      // Seed the chip's tag cache from the listed rows so a bound session reads
      // its ledger tag once listed (or re-resumed after a legacy backfill).
      sessionTagStore.seedTag(row.session_id, row.tag);
      sessionSynopsisStore.seedSynopsis(row.session_id, row.synopsis);
    }
    publishListSessionsOk({
      project_dir: projectDir,
      sessions: rows,
      dir_exists: dirExists,
      scanning,
    });
  });
  // spawn_session_error: the supervisor rejected a `spawn_session`
  // (e.g. the project directory no longer exists). The router echoes
  // the originating `card_id` so the failure routes to that card's
  // picker, which surfaces it as an inline alert — the unbound card has
  // no CodeSessionStore to carry it.
  registerAction("spawn_session_error", (payload) => {
    const cardId = payload.card_id;
    if (typeof cardId !== "string") {
      console.warn("spawn_session_error: missing card_id", payload);
      return;
    }
    const detail = payload.detail;
    sessionSpawnErrorStore.set(cardId, {
      reason: typeof detail === "string" ? detail : "unknown",
    });
    // A rejection during the startup restore pass leaves a
    // `sessionRestoreRegistry` hold in place — the zero-turn fresh-spawn
    // path arms one so the card doesn't flash the picker mid-bind.
    // Drop it so the card falls through to the picker, which reads the
    // error set above and shows its inline alert.
    notifySpawnRejected(cardId);
  });
  registerAction("list_sessions_err", (payload) => {
    const projectDir = payload.project_dir;
    const reason = payload.reason;
    if (typeof projectDir !== "string" || typeof reason !== "string") {
      console.warn("list_sessions_err: missing or invalid fields", payload);
      return;
    }
    publishListSessionsErr({ project_dir: projectDir, reason });
  });
  // list_sessions_progress: throttled scan-progress ticks emitted while
  // the phase-2 JSONL scan parses cache misses. Drives the picker's
  // determinate "N of M" indicator next to the Sessions label.
  registerAction("list_sessions_progress", (payload) => {
    const projectDir = payload.project_dir;
    const parsed = payload.parsed;
    const total = payload.total;
    if (
      typeof projectDir !== "string" ||
      typeof parsed !== "number" ||
      typeof total !== "number"
    ) {
      console.warn("list_sessions_progress: missing or invalid fields", payload);
      return;
    }
    publishListSessionsProgress({ project_dir: projectDir, parsed, total });
  });

  // list_card_bindings_ok / _err: response to a startup/reconnect
  // request from `restoreSessions`.
  registerAction("list_card_bindings_ok", (payload) => {
    const bindings = payload.bindings;
    if (!Array.isArray(bindings)) {
      console.warn("list_card_bindings_ok: missing or invalid bindings", payload);
      return;
    }
    const rows = bindings as CardBinding[];
    // Seed the chip's name cache on restore ([#step-13d]) so a session renamed
    // in a prior run shows its name the moment its card rebinds. Only a user
    // `/rename` feeds the chip; an auto `aiTitle` leaves it on the hash.
    for (const b of rows) {
      sessionNameStore.seedName(b.session_id, b.name_user_set ? (b.name ?? null) : null);
      // Seed the chip's tag cache on restore so a session's mnemonic shows the
      // moment its card rebinds (parity with the name seed).
      sessionTagStore.seedTag(b.session_id, b.tag ?? null);
      sessionSynopsisStore.seedSynopsis(b.session_id, b.synopsis ?? null);
    }
    publishListCardBindingsOk({ bindings: rows });
  });
  registerAction("list_card_bindings_err", (payload) => {
    const reason = payload.reason;
    if (typeof reason !== "string") {
      console.warn("list_card_bindings_err: missing reason", payload);
      return;
    }
    publishListCardBindingsErr({ reason });
  });

  // resolve_sessions_ok / _err: the ledger's answer to "which of these cited
  // sessions do you hold?" ([D132]). The store settles both the hits and the
  // misses — a named miss is what lets an unresolvable citation be a cached
  // fact instead of a re-ask on every repaint — and seeds the identity stores
  // from the rows, which is how a citation names a session no card is bound to.
  registerAction("resolve_sessions_ok", (payload) => {
    const decoded = decodeResolveSessionsOk(payload);
    if (decoded === null) {
      console.warn("resolve_sessions_ok: undecodable payload", payload);
      return;
    }
    sessionCitationStore.applyResolved(decoded);
  });
  registerAction("resolve_sessions_err", (payload) => {
    // A read error says nothing about the sessions, so the asks are dropped
    // rather than cached as misses: caching one would slash a resolvable
    // citation until the next reconnect.
    const ids = Array.isArray(payload.ids)
      ? payload.ids.filter((id): id is string => typeof id === "string")
      : [];
    console.warn("resolve_sessions_err", payload.reason, ids.length);
    sessionCitationStore.applyFailed(ids);
  });

  // trash_session_ok / _err
  registerAction("trash_session_ok", (payload) => {
    const sessionId = payload.session_id;
    if (typeof sessionId !== "string") {
      console.warn("trash_session_ok: missing session_id", payload);
      return;
    }
    publishTrashSessionOk({ session_id: sessionId });
  });
  registerAction("trash_session_err", (payload) => {
    const sessionId = payload.session_id;
    const reason = payload.reason;
    if (typeof sessionId !== "string" || typeof reason !== "string") {
      console.warn("trash_session_err: missing or invalid fields", payload);
      return;
    }
    publishTrashSessionErr({ session_id: sessionId, reason });
  });

  // trash_project_dir_sessions_ok / _err: response to a recents-eviction
  // → ledger-eviction dispatch from `card-services-store.ts`. The caller
  // is fire-and-forget (no UX surface waits on the ack), but registering
  // the handlers keeps the unknown-action warning out of the console.
  registerAction("trash_project_dir_sessions_ok", (payload) => {
    const projectDir = payload.project_dir;
    const count = payload.count;
    if (typeof projectDir !== "string" || typeof count !== "number") {
      console.warn("trash_project_dir_sessions_ok: missing or invalid fields", payload);
      return;
    }
    publishTrashProjectDirSessionsOk({ project_dir: projectDir, count });
  });
  registerAction("trash_project_dir_sessions_err", (payload) => {
    const projectDir = payload.project_dir;
    const reason = payload.reason;
    if (typeof projectDir !== "string" || typeof reason !== "string") {
      console.warn("trash_project_dir_sessions_err: missing or invalid fields", payload);
      return;
    }
    publishTrashProjectDirSessionsErr({ project_dir: projectDir, reason });
  });

  // list_session_state_changes_ok / _err: response to a
  // `list_session_state_changes` request from the popover-side reader
  // store. Rows are oldest-first by insertion order; unknown sessions
  // surface as an empty array (not an error).
  registerAction("list_session_state_changes_ok", (payload) => {
    const tugSessionId = payload.tug_session_id;
    const rows = payload.rows;
    if (typeof tugSessionId !== "string" || !Array.isArray(rows)) {
      console.warn("list_session_state_changes_ok: missing or invalid fields", payload);
      return;
    }
    publishListSessionStateChangesOk({
      tug_session_id: tugSessionId,
      rows: rows as SessionStateChangeWireRow[],
    });
  });
  registerAction("list_session_state_changes_err", (payload) => {
    const tugSessionId = payload.tug_session_id;
    const reason = payload.reason;
    if (typeof tugSessionId !== "string" || typeof reason !== "string") {
      console.warn("list_session_state_changes_err: missing or invalid fields", payload);
      return;
    }
    publishListSessionStateChangesErr({ tug_session_id: tugSessionId, reason });
  });

  // list_pulse_lines_ok: response to the pulse-store's app-scoped
  // ledger-tail request. Lines are oldest-first; an empty ledger is a
  // valid empty array.
  registerAction("list_pulse_lines_ok", (payload) => {
    const lines = payload.lines;
    if (!Array.isArray(lines)) {
      console.warn("list_pulse_lines_ok: missing or invalid lines", payload);
      return;
    }
    publishListPulseLinesOk({ lines: lines as PulseLineWireRow[] });
  });

  // list_overview_posts_ok: response to the overview-store's app-scoped
  // ledger-tail request. Posts are oldest-first; an empty channel is a
  // valid empty array.
  registerAction("list_overview_posts_ok", (payload) => {
    const posts = payload.posts;
    if (!Array.isArray(posts)) {
      console.warn("list_overview_posts_ok: missing or invalid posts", payload);
      return;
    }
    publishListOverviewPostsOk({ posts: posts as OverviewPostWire[] });
  });

  // list_shell_exchanges_ok ([P07]): the shell-restore tail for one session.
  // Route the ledgered exchanges to the owning card's code-session store,
  // which interleaves them by timestamp among the JSONL-replayed Claude turns.
  registerAction("list_shell_exchanges_ok", (payload) => {
    const sid = payload.tug_session_id;
    const exchanges = payload.exchanges;
    if (typeof sid !== "string" || !Array.isArray(exchanges)) {
      console.warn("list_shell_exchanges_ok: missing session id / exchanges", payload);
      return;
    }
    const services = cardServicesStore.getByTugSessionId(sid);
    if (services === null) return;
    applyRestoredShellExchanges(
      services.codeSessionStore,
      exchanges as ReadonlyArray<Record<string, unknown>>,
    );
  });

  // list_refs_ok ([P05]): the refs-restore read for one session. The ledger
  // keeps the latest run only, so `run` is that run or `null` for a session
  // that has never searched. Re-minting it seats the `#r` block in the
  // transcript and restores the list `/ref N` resolves against.
  registerAction("list_refs_ok", (payload) => {
    const sid = payload.tug_session_id;
    if (typeof sid !== "string") {
      console.warn("list_refs_ok: missing session id", payload);
      return;
    }
    const services = cardServicesStore.getByTugSessionId(sid);
    if (services === null) return;
    const run = payload.run;
    applyRestoredRefs(
      services.codeSessionStore,
      services.refsSessionStore,
      typeof run === "object" && run !== null ? (run as Record<string, unknown>) : null,
    );
  });

  // voiceover-changed: the host's VoiceOver signal ([P10]). The Swift
  // side observes `NSWorkspace.shared.isVoiceOverEnabled` and sends a
  // control frame with `enabled: <bool>` on launch, on frontend
  // (re)connect, and on every change. VoiceOver on flips the
  // keyboard-access mode to `accessibility` (the focus-follows mirror —
  // real DOM focus on every key view, the one pattern every AT
  // handles). VoiceOver off undoes only a flip detection itself made —
  // a user who persisted `accessibility` without VoiceOver (Switch
  // Control, full-keyboard users) keeps it. `persist: false` — the flip
  // is environment detection, not a user setting, so it never
  // overwrites the persisted tugbank preference.
  registerAction("voiceover-changed", (payload) => {
    const enabled = payload.enabled;
    if (typeof enabled !== "boolean") {
      console.warn("voiceover-changed: missing or invalid enabled", payload);
      return;
    }
    if (enabled) {
      if (keyboardAccessStore.getMode() !== "accessibility") {
        voiceOverDroveAccessibility = true;
        keyboardAccessStore.setMode("accessibility", { persist: false });
      }
    } else if (voiceOverDroveAccessibility) {
      voiceOverDroveAccessibility = false;
      keyboardAccessStore.setMode("standard", { persist: false });
    }
  });

  // app-lifecycle: route macOS `NSApplicationDelegate` events into the
  // `AppLifecycle` singleton. The Swift side sends a control frame with
  // `action: "app-lifecycle"` and `event: "<willBecomeActive|didBecomeActive|
  // willResignActive|didResignActive|willHide|didHide|willUnhide|didUnhide>"`;
  // this handler dispatches to the matching `notifyApplication*` method.
  //
  // This control-frame path replaces earlier ad-hoc window globals so
  // the app lifecycle is a single unified pipe rather
  // than a set of one-off RPC functions.
  registerAction("app-lifecycle", (payload) => {
    const event = payload.event;
    if (typeof event !== "string") {
      console.warn("app-lifecycle: missing or invalid event", payload);
      return;
    }
    const lifecycle = getAppLifecycle();
    if (lifecycle === null) {
      console.warn(
        `app-lifecycle: AppLifecycle not registered yet (event=${event})`,
      );
      return;
    }
    // The Swift host tags frames replayed on tugcast reconnect with
    // `replayed: true` so the lifecycle trace can distinguish the
    // recovery path from a literal OS notification. Observers see no
    // difference — they are idempotent under repeated `did*` events
    // by contract (see `app-lifecycle.ts` JSDoc).
    if (payload.replayed === true) {
      console.log(`[AppLifecycle] replayed ${event} (post-reconnect resync)`);
    }
    switch (event) {
      case "willBecomeActive":
        lifecycle.notifyApplicationWillBecomeActive();
        break;
      case "didBecomeActive":
        lifecycle.notifyApplicationDidBecomeActive();
        break;
      case "willResignActive":
        lifecycle.notifyApplicationWillResignActive();
        break;
      case "didResignActive":
        lifecycle.notifyApplicationDidResignActive();
        break;
      case "willHide":
        lifecycle.notifyApplicationWillHide();
        break;
      case "didHide":
        lifecycle.notifyApplicationDidHide();
        break;
      case "willUnhide":
        lifecycle.notifyApplicationWillUnhide();
        break;
      case "didUnhide":
        lifecycle.notifyApplicationDidUnhide();
        break;
      default:
        console.warn(`app-lifecycle: unknown event ${event}`);
    }
  });

  // Save all card states around app backgrounding.
  //
  // Primary triggers are the **will-phase** events (`willResignActive`,
  // `willHide`). Firing on the will-phase is the [L23] win: the save
  // callbacks read `document.activeElement`, `selectionStart/End`, and
  // `selectionGuard.getCardRange(cardId)` *before* WebKit tears down
  // selection visibility and blurs the active input when the app
  // loses key status. A did-phase save would read a post-teardown
  // state and record `focus: none` with no selection. (See
  // [Collision 3](#audit-collisions) in design doc.)
  //
  // The **did-phase** `didResignActive` subscriber stays as an
  // idempotent backstop: if a will-phase event never arrived (older
  // host, test harness, unexpected teardown path), the did-phase save
  // still flushes whatever state is readable. Repeating a save is
  // harmless — `saveAndFlush` is debounce-free and idempotent.
  //
  // Selection repaint on the symmetric become-active / unhide events is
  // owned by the selection-guard paint authority.
  //
  // `getAppLifecycle()` is guaranteed non-null here because
  // `DeckManager` registers the lifecycle before `initActionDispatch`
  // is called.
  const disposers: Array<() => void> = [
    controlUnsub,
    // The wire to answer questions on, the fallback target for a question that
    // names no session, and the session registry — the store holds no singleton
    // of its own, so this is the only place the two are joined.
    pendingAskStore.init({
      sendControlFrame: (action, payload) =>
        connection.sendControlFrame(action, payload),
      focusedTugSessionId: () => {
        const cardId = deckManager.getFocusedCardId();
        if (cardId === null) return null;
        return cardServicesStore.getServices(cardId)?.tugSessionId ?? null;
      },
      sessionFor: (tugSessionId) => {
        const services = cardServicesStore.getByTugSessionId(tugSessionId);
        if (services === null) return null;
        return {
          tugSessionId: services.tugSessionId,
          setPendingAsk: (ask) => services.codeSessionStore.setPendingAsk(ask),
        };
      },
      observeSessions: (listener) => cardServicesStore.subscribe(listener),
    }),
  ];
  const appLifecycle = getAppLifecycle();
  if (appLifecycle !== null) {
    disposers.push(
      appLifecycle.observeApplicationWillResignActive(() => {
        deckManager.saveAndFlush();
      }),
      appLifecycle.observeApplicationWillHide(() => {
        deckManager.saveAndFlush();
      }),
      appLifecycle.observeApplicationDidResignActive(() => {
        deckManager.saveAndFlush();
      }),
    );
  } else {
    console.warn(
      "initActionDispatch: AppLifecycle not registered; save-on-resign wire skipped",
    );
  }

  return () => {
    for (const dispose of disposers) dispose();
    disposers.length = 0;
  };
}
