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
import { FeedId } from "./protocol";
import { BASE_THEME_NAME } from "./theme-constants";
import { raiseCard } from "./focus-transfer";
import {
  revealSidebarCard,
  toggleSidebarCard,
  toggleSidebars,
} from "./sidebar-toggle";
import { isSlotWindowSize, writeSlotWindow } from "@/lib/slot-window-pref";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { isCommandId } from "@/components/tugways/command-registry";
import { advanceKeyViewFocus, getFocusManager, BASE_FOCUS_MODE } from "@/components/tugways/focus-manager";
import { dispatchCommand, sendToCardContent } from "./command-dispatch";
import { closeCard, closePane, deleteSpace } from "./lib/card-close-commands";
import { requestSettingsReveal } from "./lib/settings-reveal";
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from "./lib/settings-sections-pref";
import { openDiffInCard } from "@/lib/open-diff-in-card";
import { openCommitInCard } from "@/lib/open-commit-in-card";
import {
  _resetActionRegistryForTest,
  getRegistryHandler,
  getResponderChainManager,
  registerAction,
  registerResponderChainManager,
  type ActionHandler,
} from "./action-registry";
import { isFocusDirection } from "@/lib/directional-focus";
import {
  flashCardPane,
  flashPaneBorder,
  flashPaneBorderOnSettle,
} from "@/lib/flash-pane-border";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import { isDiffDescriptor } from "@/lib/git-diff-store";
import {
  isColumnMoveTarget,
  isContentWidth,
  isImpositionKind,
  isImpositionLayout,
  isResizeSlot,
  isColumnMode,
  isSidebarSide,
} from "@/lib/layout-imposer";
import { JOTS_CARD_ID } from "@/lib/jots-card-id";
import { ARCS_CARD_ID } from "@/lib/arcs-card-id";
import { CARDS_CARD_ID } from "@/lib/cards-card-id";
import { LAYOUT_CARD_ID } from "@/lib/layout-card-id";
import { OVERVIEW_CARD_ID } from "@/lib/overview-card-id";
import {
  cardIdForSession,
  cardSessionBindingStore,
} from "./lib/card-session-binding-store";
import { arcPressStore } from "./lib/arc-press-store";
import { sessionNameStore } from "./lib/session-name-store";
import {
  identityKeyForSession,
  sessionLineStore,
} from "./lib/session-line-store";
import { sessionTagStore } from "./lib/session-tag-store";
import { sessionSynopsisStore } from "./lib/session-synopsis-store";
import { sessionCitationStore } from "./lib/session-citation-store";
import {
  applyAuthResultPayload,
  applyDownloadEnded,
  applyDownloadFallbackPayload,
  applyDownloadProgressPayload,
  applyDownloadStoppedPayload,
  applyInstallResultPayload,
  applyLogoutResultPayload,
} from "./lib/auth-store";
import {
  applyVersionResultPayload,
  applyUpdateResultPayload,
} from "./lib/claude-version-store";
import {
  applyHostToolsResultPayload,
  applyHostToolsOfferResultPayload,
} from "./lib/host-tools-store";
import { requestLogout } from "./lib/logout-store";
import { requestConfigureTug } from "./lib/configure-tug-request-store";
import { appModalStore } from "./lib/app-modal-store";
import {
  fireFreshSpawn,
  fireRestore,
  stashOpeningCommand,
} from "./lib/session-restore";
import { appInfoStore } from "./lib/app-info-store";
import { getAppLifecycle } from "./lib/app-lifecycle";
import { keyboardAccessStore } from "./keyboard-access-store";
import {
  decodeResolveSessionsOk,
  normalizeSessionRow,
} from "./protocol";
import type {
  OverviewPostWire,
  DigestLineWireRow,
  SessionStateChangeWireRow,
} from "./protocol";
import { publishListDigestLinesOk } from "./lib/digest-store";
import { publishListOverviewPostsOk } from "./lib/overview-store";
import { cardServicesStore } from "./lib/card-services-store";
import { mark as perfMark, marksEnabled } from "@/lib/perf-marks";
import { pendingAskStore } from "./lib/pending-ask-store";
import { registerSessionControlActions } from "./lib/session-control-actions";
import {
  publishListSessionsOk,
  publishListSessionsProgress,
  publishListSessionsErr,
  publishTrashSessionOk,
  publishTrashSessionErr,
  publishListSessionStateChangesOk,
  publishListSessionStateChangesErr,
} from "./lib/session-ledger-events";

// The handler map and the chain-manager slot live in `action-registry.ts`, so
// the command funnel, focus transfer, and the responder-chain provider can
// read them without importing this module. Re-exported for every caller.
export {
  getRegistryHandler,
  getResponderChainManager,
  registerAction,
  registerResponderChainManager,
  type ActionHandler,
};

/**
 * Ordered list of all shipped themes.
 * Must stay in sync with tugdeck/styles/themes/*.css plus the base theme.
 * Base theme always comes first. The remainder are grouped by mode — the dark
 * themes, then the light themes — so the `next-theme` cycle sweeps through all
 * darks before all lights instead of ping-ponging between modes.
 */
export const SHIPPED_THEME_NAMES: readonly string[] = [
  BASE_THEME_NAME, // ironclad (dark)
  "caravel", // dark
  "barque", // dark
  "galleon", // dark
  "collier", // dark
  "sloop", // light
  "ketch", // light
  "skiff", // light
  "kayak", // light
  "pinnace", // light
];

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

/** TextDecoder for UTF-8 payload decoding */
const textDecoder = new TextDecoder();

/**
 * A payload's `originCardId` — the card an opening gesture was made in.
 */
function originOf(payload: Record<string, unknown>): string | null {
  return typeof payload.originCardId === "string" ? payload.originCardId : null;
}

/**
 * Reset handler registry and module state for test isolation.
 * Internal/test-only -- must never be called from production code.
 */
export function _resetForTest(): void {
  _resetActionRegistryForTest();
  reloadPending = false;
  voiceOverDroveAccessibility = false;
  themeSetterRef = null;
  themeGetterRef = null;
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

  const handler = getRegistryHandler(action);
  if (handler) {
    handler(payload);
  } else {
    console.warn(`dispatchAction: unknown action: ${action}`, payload);
  }
}

/**
 * Register `eval`: run an expression in this page and answer on
 * `eval-response`. Every page that can be inspected from outside registers
 * it — the shell from {@link initActionDispatch}, a body from its own boot.
 */
export function registerEvalAction(connection: TugConnection): void {
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
      // eslint-disable-next-line no-eval -- evaluating the caller's code is this path's whole job
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

  registerEvalAction(connection);

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

  // claude_install_progress: bytes of the Tug-managed download, published on
  // a whole-percent change ([B06]). The row's bar and its detail line are
  // painted from the store directly, so these frames cost no re-render.
  registerAction("claude_install_progress", (payload) => {
    applyDownloadProgressPayload(payload);
  });

  // claude_download_stopped: the download was paused (bytes kept, on disk) or
  // cancelled (bytes gone). No install result follows a stop — the row is
  // holding its place rather than finished.
  registerAction("claude_download_stopped", (payload) => {
    applyDownloadStoppedPayload(payload);
  });

  // claude_install_fallback: the release channel could not be read, so the
  // official script is running instead ([B08]). No bytes will follow.
  registerAction("claude_install_fallback", () => {
    applyDownloadFallbackPayload();
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
    // The update's transfer was the auth store's — it is the one that carries
    // the bytes and the busy flag — and this frame is the only thing that ends
    // it, because an update reports on the version store's frame instead.
    applyDownloadEnded();
  });

  // host_tools_result: tugcast's answer to `check_host_tools` — whether this
  // machine carries a git Tug can use. Also re-broadcast after an offer, and
  // again when the Command Line Tools actually land on disk, so the row settles
  // on what is really there rather than on what was asked for.
  registerAction("host_tools_result", (payload) => {
    applyHostToolsResultPayload(payload);
  });

  // host_tools_offer_result: outcome of `offer_host_tools`. Success only means
  // Apple's installer started — the re-probe is what says git arrived.
  registerAction("host_tools_offer_result", (payload) => {
    applyHostToolsOfferResultPayload(payload);
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
  //
  // Dropped outright while the update wizard holds the app ([B04]). The menu
  // item is dark for the same span, so this is the palette's and the control
  // frame's half of one rule — an action that raised a second app-modal over
  // the first would stack them, which is the thing Spec S02 forbids.
  registerAction("configure-tug", () => {
    if (appModalStore.isOpenFor("update-tug")) return;
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

  // apply-theme-to-all-workspaces: every workspace takes the current
  // workspace's theme. Nothing on screen changes — the current workspace
  // already wears it — so this is a record write and nothing else.
  registerAction("apply-theme-to-all-workspaces", () => {
    deckManager.applyThemeToAllSpaces();
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

  // toggle-jots / toggle-cards / toggle-overview: the three-state sidebar
  // shortcut over one CARD — show-and-activate, activate, hide
  // ({@link toggleSidebarCard}). Fired by the Swift menu's "Show Jots", "Show
  // Cards" and "Show Overview" rows, which carry no default chord: the keyboard
  // addresses the rails instead (`toggle-rail` below).
  registerAction("toggle-jots", () => {
    toggleSidebarCard(deckManager, JOTS_CARD_ID);
  });

  registerAction("toggle-arcs", () => {
    toggleSidebarCard(deckManager, ARCS_CARD_ID);
  });

  registerAction("toggle-cards", () => {
    toggleSidebarCard(deckManager, CARDS_CARD_ID);
  });

  registerAction("toggle-layout", () => {
    toggleSidebarCard(deckManager, LAYOUT_CARD_ID);
  });

  registerAction("toggle-overview", () => {
    toggleSidebarCard(deckManager, OVERVIEW_CARD_ID);
  });

  // toggle-rail: the Maker ▸ Show Left/Right Rail round-trip, the same
  // bare-name / parameterized-id shape the Go to Slot row uses. The host's one
  // wire name hands off to `toggle-rail:left` / `toggle-rail:right`, so the
  // menu item and the ⌃⌘ arrow end at ONE handler on the canvas — which is
  // where the ladder can see the deck's sides.
  registerAction(TUG_ACTIONS.TOGGLE_RAIL, (payload) => {
    const side = payload.value;
    if (!isSidebarSide(side)) {
      console.warn(`${TUG_ACTIONS.TOGGLE_RAIL}: invalid side`, payload);
      return;
    }
    dispatchCommand(`${TUG_ACTIONS.TOGGLE_RAIL}:${side}`);
  });

  // reveal-arcs: show the Arcs rail and bring the keyboard to it, never
  // hide it.
  // What a link means, as distinct from what a shortcut means — an arc chip
  // on an Overview post promises to reveal the arc, and a toggle would take
  // the rail away from a reader who already had it open.
  registerAction("reveal-arcs", () => {
    revealSidebarCard(deckManager, ARCS_CARD_ID);
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
  // handler (a rail card, a diff card, anything Class-B) reports unhandled, and
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
  // Dispatched by the Layout card's kind picker. `kind: null` clears
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
    const preset = payload.preset;
    if (!isContentWidth(preset)) {
      console.warn("set-card-width: missing or invalid preset", payload);
      return;
    }
    // Card-addressed and plural, or pane-addressed and single. The title bar's
    // width popup names a pane, because that is what it sits on; the ⌃⌘-digit
    // chord names the layout selection, which is cards. The plural path
    // commits all of the widths at once for the settle's sake.
    if (Array.isArray(payload.cardIds)) {
      const cardIds = payload.cardIds.filter(
        (id): id is string => typeof id === "string",
      );
      if (cardIds.length !== payload.cardIds.length) {
        console.warn("set-card-width: invalid cardIds", payload);
        return;
      }
      deckManager.setCardWidths(cardIds, preset);
      return;
    }
    const paneId = payload.paneId;
    if (typeof paneId !== "string") {
      console.warn("set-card-width: missing or invalid paneId", payload);
      return;
    }
    deckManager.setPaneWidth(paneId, preset);
  });

  // fill-card-height: give one slotted card its run's full height again.
  // Dispatched by the Fill Height row of the pane title bar's width popup,
  // which addresses the pane by id for the reason `set-card-width` does.
  registerAction(TUG_ACTIONS.FILL_CARD_HEIGHT, (payload) => {
    const paneId = payload.paneId;
    if (typeof paneId !== "string") {
      console.warn("fill-card-height: missing or invalid paneId", payload);
      return;
    }
    deckManager.fillPaneHeight(paneId);
  });

  // set-card-folded: write one card's pane into or out of the folded
  // form ([P02], Spec S01). Card-addressed rather than pane-addressed because
  // every door — the Z2 fold control, View ▸ Fold Card, and
  // ⌃⌘Y — knows which card it is about and not which pane holds it. The
  // validation shape is `set-card-width`'s: warn
  // and return rather than throw, because a malformed payload is a caller's
  // defect and taking the deck down over one helps nobody.
  registerAction(TUG_ACTIONS.SET_CARD_FOLDED, (payload) => {
    const cardId = payload.cardId;
    if (typeof cardId !== "string") {
      console.warn("set-card-folded: missing or invalid cardId", payload);
      return;
    }
    const folded = payload.folded;
    if (typeof folded !== "boolean") {
      console.warn("set-card-folded: missing or invalid folded", payload);
      return;
    }
    deckManager.setCardFolded(cardId, folded);
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
  // deck. Dispatched by the Layout card's width picker. It lands on
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

  // set-imposition-layout: choose whether slots resolve as band fractions (fit)
  // or as positions in a strip (flow). Dispatched by the Layout card's
  // Layout group. Orthogonal to the kind: the deck keeps its N-up rule and
  // every card keeps its slot, and only what a slot MEANS changes.
  registerAction(TUG_ACTIONS.SET_IMPOSITION_LAYOUT, (payload) => {
    const layout = payload.layout;
    if (!isImpositionLayout(layout)) {
      console.warn("set-imposition-layout: missing or invalid layout", payload);
      return;
    }
    deckManager.setImpositionLayout(layout);
  });

  // set-resize-slot: choose whether an edge resize keeps an imposed card in its
  // slot or releases it into free pixels. Dispatched by the Layout card's
  // Resizing row. A rule for later gestures; nothing moves when it changes.
  registerAction(TUG_ACTIONS.SET_RESIZE_SLOT, (payload) => {
    const resizeSlot = payload.resizeSlot;
    if (!isResizeSlot(resizeSlot)) {
      console.warn("set-resize-slot: missing or invalid resizeSlot", payload);
      return;
    }
    deckManager.setResizeSlot(resizeSlot);
  });

  // set-sidebar-side: choose the side of the deck a sidebar card holds — the
  // other axis of the imposition. Dispatched by the Layout card, one
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

  // set-sidebar-open: show or hide a sidebar card outright. Dispatched by the
  // Layout card's per-card row. Deliberately NOT the three-state
  // toggle: that one is a summons and moves the keyboard; this one states
  // where things stand, and a settings row that stole focus on every press
  // would make the section unusable from the keyboard.
  registerAction(TUG_ACTIONS.SET_SIDEBAR_OPEN, (payload) => {
    const componentId = payload.componentId;
    const open = payload.open;
    if (typeof componentId !== "string" || typeof open !== "boolean") {
      console.warn(
        "set-sidebar-open: missing or invalid componentId/open",
        payload,
      );
      return;
    }
    if (open) {
      deckManager.showSidebarPane(componentId);
    } else {
      deckManager.hideSidebarPane(componentId);
    }
  });

  // set-slot-window: how many places a Cards card row draws around its own.
  // Dispatched by the Layout card's Slot Window row. The only action
  // in this neighbourhood that touches no deck state at all — nothing moves,
  // nothing is arranged, the rows simply state the same fact at another width
  // — so it writes the preference and stops. Every row reads it through
  // `useSlotWindow` ([L02]) and redraws from the local cache write.
  registerAction(TUG_ACTIONS.SET_SLOT_WINDOW, (payload) => {
    const size = payload.size;
    if (!isSlotWindowSize(size)) {
      console.warn("set-slot-window: missing or invalid size", payload);
      return;
    }
    writeSlotWindow(size);
  });

  // set-column-mode: stack or split the cards sharing one numbered slot.
  // Dispatched by the title bar's stack badge menu, the Layout card's
  // per-slot column row, and ⌃⌘/. A slot is a stack or a split — all of its
  // members participate, which is why the payload names a slot rather than a
  // pair of cards.
  registerAction(TUG_ACTIONS.SET_COLUMN_MODE, (payload) => {
    const slot = payload.slot;
    const mode = payload.mode;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0) {
      console.warn("set-column-mode: missing or invalid slot", payload);
      return;
    }
    if (!isColumnMode(mode)) {
      console.warn("set-column-mode: missing or invalid mode", payload);
      return;
    }
    deckManager.setColumnMode(slot, mode);
  });

  // equalize-column: divide a split column's run equally again. Dispatched by
  // the stack badge menu. The slot's mode and member order survive — only the
  // division is rewritten.
  registerAction(TUG_ACTIONS.EQUALIZE_COLUMN, (payload) => {
    const slot = payload.slot;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0) {
      console.warn("equalize-column: missing or invalid slot", payload);
      return;
    }
    deckManager.equalizeColumn(slot);
  });

  // resize-sidebars-to-fit: stand every rail's cards at the heights their
  // content asks for, once. Dispatched by ⌥⇧⌘S and the View menu row, and
  // by nothing else — the result is a division like any the hand makes, and
  // no resize, content change or membership change re-runs it ([B07]).
  registerAction(TUG_ACTIONS.RESIZE_SIDEBARS_TO_FIT, () => {
    deckManager.resizeSidebarsToFit();
  });

  // toggle-sidebars: clear both of the deck's edges, or put back what the last
  // clearing took away ({@link toggleSidebars}). Dispatched by ⌃⌘S and the
  // Window row that stands above Resize Sidebars to Fit — the two verbs about
  // the rails as a whole, next to each other.
  registerAction(TUG_ACTIONS.TOGGLE_SIDEBARS, () => {
    toggleSidebars(deckManager);
  });

  // assign-slot: put a card's pane at a numbered position in the active
  // imposition. Dispatched by ⌘1..⌘9 on the deck canvas and by the `SlotPicker`
  // cluster on the Cards card's session and text-file rows. `slot` is 0-based (the
  // buttons render 1-based).
  //
  // The assignment always flashes the card's pane, including when the card was
  // already in the slot the caller named. A chord that lands on the slot the
  // frontmost card already holds moves nothing, and without the flash it is
  // indistinguishable from a chord that did not land at all — so the flash is
  // the gesture's receipt, not a decoration on the motion ([P04], [L06]).
  registerAction("assign-slot", (payload) => {
    // One card or several, through one door. `cardIds` is what the ⌘-digit
    // chord sends once the deck has a layout selection; `cardId` is the
    // SlotPicker's single-row shape. Both land in the batched mutator, which
    // commits the whole group's geometry once — a notify per card would
    // re-arm the FLIP settle mid-flight and break the motion.
    const raw = Array.isArray(payload.cardIds)
      ? payload.cardIds
      : [payload.cardId];
    const cardIds = raw.filter((id): id is string => typeof id === "string");
    if (cardIds.length === 0 || cardIds.length !== raw.length) {
      console.warn("assign-slot: missing or invalid cardId(s)", payload);
      return;
    }
    const slot = payload.slot;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0) {
      console.warn("assign-slot: missing or invalid slot", payload);
      return;
    }
    deckManager.assignCardsToSlots(cardIds.map((cardId) => ({ cardId, slot })));
    // Read the panes back AFTER the call: a card pulled out of a tab group
    // lands in a pane that did not exist before it. `slot` being set is what
    // separates an assignment that happened from one the mutator refused (no
    // imposition, sidebar host) — a refusal must not flash.
    const panes = deckManager.getSnapshot().panes;
    const flashed = new Set<string>();
    for (const cardId of cardIds) {
      const landed = panes.find((p) => p.cardIds.includes(cardId));
      if (landed?.slot === undefined || flashed.has(landed.id)) continue;
      flashed.add(landed.id);
      flashPaneBorder(landed.id);
    }
  });

  // nudge-slot-selection: move every named card one slot along the
  // arrangement. The relative sibling of `assign-slot`, and a separate door
  // rather than a payload on that one because the two differ in what success
  // looks like: an absolute assign always flashes, because landing on the slot
  // you were already in is otherwise indistinguishable from a chord that never
  // arrived, while a nudge that took has moved the deck and needs no receipt
  // beyond the motion ([P08]). What a nudge flashes is the REFUSAL.
  //
  // Cards with no slot of their own drop out rather than refusing the gesture —
  // a card in a tab group travels with its host and has no independent place to
  // be nudged from. A selection made entirely of those has nothing to move, and
  // says so in the dev log rather than dying silently.
  registerAction("nudge-slot-selection", (payload) => {
    const raw = Array.isArray(payload.cardIds) ? payload.cardIds : [];
    const cardIds = raw.filter((id): id is string => typeof id === "string");
    if (cardIds.length === 0 || cardIds.length !== raw.length) {
      console.warn("nudge-slot-selection: missing or invalid cardIds", payload);
      return;
    }
    const delta = payload.delta;
    if (delta !== -1 && delta !== 1) {
      console.warn("nudge-slot-selection: delta must be -1 or 1", payload);
      return;
    }

    const panes = deckManager.getSnapshot().panes;
    const entries: { cardId: string; slot: number }[] = [];
    for (const cardId of cardIds) {
      const host = panes.find((p) => p.cardIds.includes(cardId));
      if (host?.slot === undefined) continue;
      entries.push({ cardId, slot: host.slot + delta });
    }
    if (entries.length === 0) {
      tugDevLogStore.debug("nudge-slot", "no slotted card in the selection", {
        cardIds: cardIds.length,
        delta,
      });
      return;
    }

    // The clamp lives in the mutator, so every caller gets the group rule: one
    // member already against the edge in the travel direction refuses the whole
    // nudge, and the selection keeps the arrangement the user was moving.
    const result = deckManager.assignCardsToSlots(entries);
    if (result.ok) return;
    if (result.blockedCardId !== undefined) {
      flashCardPane(deckManager, result.blockedCardId);
      return;
    }
    tugDevLogStore.debug("nudge-slot", "refused with nothing to blame", {
      cardIds: cardIds.length,
      delta,
    });
  });

  // focus-session-card: activate a specific card (front its pane + promote the
  // responder chain) and flash its title bar once. Dispatched by a Cards card
  // session monitor row on click ([P04]). Like `focus-pane` it routes through
  // `transferFocusForActivation` so the activation fires the full
  // will/didDeactivate + will/didActivate transition; the flash is pure
  // appearance (a CSS class toggled on the pane header DOM, removed on
  // `animationend`), never React state ([L06]).
  //
  // The flash waits for the settle this raise may have armed. On a flow deck
  // the raise walks the strip, and a ring that starts in the same frame runs
  // its first third over the motion it is announcing — so it is parked on
  // `IMPOSER_SETTLE_END` instead ([B05]). A raise that moves nothing arms no
  // settle and `flashPaneBorderOnSettle` rings immediately, which is what
  // keeps a card already in the reader's slot from going unanswered.
  const focusSessionCard = (verb: string, cardId: unknown): cardId is string => {
    if (typeof cardId !== "string") {
      console.warn(`${verb}: missing or invalid cardId`, cardId);
      return false;
    }
    let pane = deckManager
      .getSnapshot()
      .panes.find((p) => p.cardIds.includes(cardId));
    if (!pane) {
      // The card may be in a PARKED workspace — a row in an expanded inactive
      // workspace is exactly such a click ([P09]). Go there first, and then
      // front it: the pane exists in the rendered deck from the moment
      // `activateSpace` commits, so the re-read below finds it.
      const spaceId = deckManager.spaceOf(cardId);
      if (spaceId !== null) {
        deckManager.activateSpace(spaceId);
        pane = deckManager
          .getSnapshot()
          .panes.find((p) => p.cardIds.includes(cardId));
      }
    }
    if (!pane) {
      console.warn(`${verb}: no pane holds card "${cardId}"`);
      return false;
    }
    raiseCard(deckManager, cardId);
    flashPaneBorderOnSettle(pane.id);
    perfMark("tug:action-end");
    // Where the action's own work landed relative to the task boundaries
    // after it — and the scheduling is asked for rather than unconditional,
    // because a microtask and a zero timer queued inside the gesture's task
    // for a mark nobody will read is a task competing with the settle's own
    // first frame ([F08]).
    if (marksEnabled()) {
      queueMicrotask(() => perfMark("tug:action-microtask"));
      window.setTimeout(() => perfMark("tug:action-next-task"), 0);
    }
    return true;
  };
  registerAction("focus-session-card", (payload) => {
    focusSessionCard("focus-session-card", payload.cardId);
  });
  // reveal-session-changes: the raise above, then the card's Changes shade —
  // the room a surface showing that card's arc opens ([D152]). The reveal is
  // sent to the card's content wherever it lives, so a surface in one body
  // opens the shade of a card in another.
  registerAction("reveal-session-changes", (payload) => {
    const cardId = payload.cardId;
    if (!focusSessionCard("reveal-session-changes", cardId)) return;
    sendToCardContent(cardId, TUG_ACTIONS.REVEAL_CHANGES);
  });
  // reveal-settings: open or raise the Settings card and show a section of
  // it. The request is parked until a Settings card is mounted — in this
  // document, or, when the card is a body, through the consumer the shell
  // holds for it — so a bulletin in any page lands the reader on the section
  // it named ([P17]).
  registerAction("reveal-settings", (payload) => {
    const section = payload.section;
    if (typeof section !== "string" || !SETTINGS_SECTION_IDS.includes(section as SettingsSectionId)) {
      console.warn("reveal-settings: missing or unknown section", payload);
      return;
    }
    dispatchCommand(TUG_ACTIONS.SHOW_SETTINGS);
    requestSettingsReveal(section as SettingsSectionId);
  });
  // close-card / close-pane-by-id / delete-space-confirmed: a list's gestures that destroy
  // other cards, run here because this page holds those cards' close guards
  // and responders, whichever page the list is in.
  registerAction("close-card", (payload) => {
    const { cardId, spaceId } = payload;
    if (typeof cardId !== "string" || typeof spaceId !== "string") {
      console.warn("close-card: missing cardId or spaceId", payload);
      return;
    }
    closeCard(cardId, spaceId);
  });
  registerAction("close-pane-by-id", (payload) => {
    const { paneId, activeCardId, spaceId } = payload;
    if (typeof paneId !== "string" || typeof activeCardId !== "string" || typeof spaceId !== "string") {
      console.warn("close-pane-by-id: missing paneId, activeCardId or spaceId", payload);
      return;
    }
    closePane(paneId, activeCardId, spaceId);
  });
  registerAction("delete-space-confirmed", (payload) => {
    const { spaceId } = payload;
    if (typeof spaceId !== "string") {
      console.warn("delete-space-confirmed: missing spaceId", payload);
      return;
    }
    void deleteSpace(spaceId);
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
  // Placement is the deck's one opening rule, anchored on the card whose menu
  // named the session. `originCardId` is the menu's host card, which is the
  // card the reader is pointing at even when the right-click has not moved
  // first responder; the deck falls back to the first responder itself when
  // the host holds no slot — a menu mounted in a rail, say.
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
    // Save-before-activation ([L23]): `addCard` activates the fresh card
    // directly, so the surface that dispatched this — the identity row's
    // menu, mounted in some other card — must bank its focus bag first.
    if (outgoing !== null) deckManager.invokeSaveCallback(outgoing);
    const cardId = deckManager.addCard("session", undefined, {
      origin,
      opening: "bound",
    });
    if (cardId === null) {
      console.warn("resume-session: no session card registration");
      return;
    }
    // The same ring a raise draws, for the same reason: the answer to the
    // gesture is a card somewhere else on the deck, and the eye has to be
    // told where ([P04]).
    flashCardPane(deckManager, cardId);
    fireRestore(cardId, sessionId, projectDir, connection, "restore-open");
  });

  // run-command-in-new-session: open a fresh Session card on the originating
  // card's project and run the right-clicked command as its first turn.
  //
  // It is the resume-session gesture with a spawn where the restore is: the
  // card is added first and the session fired into it second, placed by the
  // deck's opening rule from the card whose menu named the command, and
  // flashed, because
  // the answer to the gesture is a card somewhere else on the deck and the
  // eye has to be told where ([P04]).
  //
  // Never a rotation on the originating card. The wheel could put a fresh
  // session on this card at the turn's end with a prompt, but that would end
  // a transcript the reader may still be reading, for work no arc has bound
  // yet ([B06]).
  //
  // The command itself rides no wire field: it is stashed against the new
  // card id and the card's own composer runs it once the binding lands. The
  // opening prompt on `session_command` belongs to the wheel's rotations and
  // stays absent on everything the deck originates ([B07]).
  registerAction(TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION, (payload) => {
    const name = payload.name;
    if (typeof name !== "string" || name === "") {
      console.warn("run-command-in-new-session: missing name", payload);
      return;
    }
    const args = typeof payload.args === "string" ? payload.args : "";
    const outgoing = deckManager.getFirstResponderCardId();
    const origin =
      typeof payload.originCardId === "string" ? payload.originCardId : null;
    // The new card opens on the SAME project as the card the command was
    // read in — a command about this project's files run against another
    // one is worse than no card at all. The origin's binding first, the
    // focused card's second, the same order the deck anchors placement in.
    const projectDir =
      (origin === null
        ? undefined
        : cardSessionBindingStore.getBinding(origin)?.projectDir) ??
      (outgoing === null
        ? undefined
        : cardSessionBindingStore.getBinding(outgoing)?.projectDir);
    if (projectDir === undefined || projectDir === "") {
      console.warn("run-command-in-new-session: no project to open on", payload);
      return;
    }
    // Save-before-activation ([L23]): `addCard` activates the fresh card, so
    // the surface that dispatched this banks its focus bag first.
    if (outgoing !== null) deckManager.invokeSaveCallback(outgoing);
    const cardId = deckManager.addCard("session", undefined, {
      origin,
      opening: "bound",
    });
    if (cardId === null) {
      console.warn("run-command-in-new-session: no session card registration");
      return;
    }
    flashCardPane(deckManager, cardId);
    // Stashed BEFORE the spawn: the binding can land inside the same tick,
    // and a drain that found nothing would open a card that sits empty
    // wearing every sign of being about to do something.
    stashOpeningCommand(cardId, { name, args });
    fireFreshSpawn(cardId, crypto.randomUUID(), projectDir, connection, "restore-open");
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
  //
  // `originCardId`, on this and on open-commit, is the card the gesture was
  // made in — a menu's host, a pill's card — which the new card is placed
  // from ahead of the first responder.
  registerAction(TUG_ACTIONS.OPEN_DIFF, (payload) => {
    const descriptor = payload.descriptor;
    if (!isDiffDescriptor(descriptor)) {
      console.warn("open-diff: missing or invalid descriptor", payload);
      return;
    }
    openDiffInCard(deckManager, descriptor, originOf(payload));
  });

  // open-commit: raise one commit's whole record in a Commit card. Sha-keyed
  // reuse with a prefix match in either direction — a card opened from a
  // `commit:<8>` pill in prose and one opened from a History row's full hash
  // are the same commit under two spellings. Dispatched by a commit atom's
  // plain click and by Open Commit in its menu.
  registerAction(TUG_ACTIONS.OPEN_COMMIT, (payload) => {
    const root = payload.root;
    const sha = payload.sha;
    if (typeof root !== "string" || typeof sha !== "string" || sha.length === 0) {
      console.warn("open-commit: missing or invalid root/sha", payload);
      return;
    }
    const raw = payload.hint;
    const hint =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : null;
    const text = (key: string): string | undefined => {
      const value = hint?.[key];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };
    const subject = text("subject");
    const author = text("author");
    const dateIso = text("dateIso");
    const seeded =
      subject === undefined && author === undefined && dateIso === undefined
        ? undefined
        : {
            ...(subject !== undefined ? { subject } : {}),
            ...(author !== undefined ? { author } : {}),
            ...(dateIso !== undefined ? { dateIso } : {}),
          };
    openCommitInCard(deckManager, { root, sha }, seeded, originOf(payload));
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
    const chain = getResponderChainManager();
    if (chain) {
      chain.sendToKeyCard({
        action: TUG_ACTIONS.RUN_SLASH_COMMAND,
        value: { name, args },
        phase: "discrete",
      });
    } else {
      console.warn("run-card-command: responder chain manager not registered yet");
    }
  });

  // set-pane-width: the View ▸ Slim / Comfy / Wide round-trip. The bare
  // wire name carries the preset as a param; the three commands the user
  // actually invokes are the parameterized ids, so this hands off to them
  // rather than reaching `setPaneWidth` itself — same shape as the
  // permission-mode submenu above, and it keeps the chain walk (and the
  // "which pane am I in" answer) on the canvas, which is the one responder
  // that can give it.
  registerAction(TUG_ACTIONS.SET_PANE_WIDTH, (payload) => {
    const preset = payload.preset;
    if (!isContentWidth(preset)) {
      console.warn(`${TUG_ACTIONS.SET_PANE_WIDTH}: invalid preset`, payload);
      return;
    }
    dispatchCommand(`${TUG_ACTIONS.SET_PANE_WIDTH}:${preset}`);
  });

  // go-to-slot: the Go ▸ Go to Slot N round-trip, the same bare-name /
  // parameterized-id shape as the width row above. The six commands the user
  // invokes are `go-to-slot:1`…`go-to-slot:6`, so the host's one wire name
  // hands off to them rather than reaching the deck itself — which is what
  // keeps the menu item and the ⌃⌘ digit at ONE handler on the canvas.
  registerAction(TUG_ACTIONS.GO_TO_SLOT, (payload) => {
    const slot = payload.value;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1) {
      console.warn(`${TUG_ACTIONS.GO_TO_SLOT}: invalid slot`, payload);
      return;
    }
    dispatchCommand(`${TUG_ACTIONS.GO_TO_SLOT}:${slot}`);
  });

  // focus-card: the Go ▸ Focus Card Left/Right/Above/Below round-trip, and
  // — because those four items are `menuEligible` — the ⌥⌘ arrow chords too.
  // AppKit resolves the key equivalent before the web view sees a keydown
  // ([P15]), fires the item's action, and the host sends this one wire with the
  // direction on it; the four commands the user invokes are
  // `focus-card:left`…`focus-card:below`. So this bridge is not a menu
  // convenience — without it neither the item nor the chord reaches the canvas
  // at all, and the reckoning behind them is unreachable.
  registerAction(TUG_ACTIONS.FOCUS_CARD, (payload) => {
    const direction = payload.value;
    if (!isFocusDirection(direction)) {
      console.warn(`${TUG_ACTIONS.FOCUS_CARD}: invalid direction`, payload);
      return;
    }
    dispatchCommand(`${TUG_ACTIONS.FOCUS_CARD}:${direction}`);
  });

  // toggle-bullseye: the View ▸ Bullseye round-trip. No payload — the
  // command is selection-relative, so the round-trip through
  // `dispatchCommand` is what keeps the "which pane am I in" answer on the
  // canvas, where the chord lands too.
  registerAction(TUG_ACTIONS.TOGGLE_BULLSEYE, () => {
    dispatchCommand(TUG_ACTIONS.TOGGLE_BULLSEYE);
  });

  // toggle-column-split / move-in-column: the Window ▸ column group's
  // round-trip, the same shape as Bullseye and the width row above. Both are
  // selection-relative, so the hand-off through `dispatchCommand` is what
  // keeps "which card is this about" on the canvas, where the chord lands
  // too — the menu item and the chord end up at one handler rather than two.
  registerAction(TUG_ACTIONS.TOGGLE_COLUMN_SPLIT, () => {
    dispatchCommand(TUG_ACTIONS.TOGGLE_COLUMN_SPLIT);
  });
  registerAction(TUG_ACTIONS.MOVE_IN_COLUMN, (payload) => {
    const where = payload.value;
    if (!isColumnMoveTarget(where)) {
      console.warn(`${TUG_ACTIONS.MOVE_IN_COLUMN}: invalid target`, payload);
      return;
    }
    dispatchCommand(`${TUG_ACTIONS.MOVE_IN_COLUMN}:${where}`);
  });

  // The session-domain acks — the spawn ack and its refusal, the arc mating,
  // the ledger's row pushes, rename and privacy, the restore's bindings, the
  // line moves and the two restore tails — live in their own module, because
  // a body page registers the same set behind its card's filter. The shell
  // takes every one.
  registerSessionControlActions();

  // The three transport verbs' answers, one pair each. The mating itself rides
  // `bind_arc_ok`, which the server sends beside a start's or a resume's `_ok`
  // — a bind is one fact whichever door it came through — so all any of these
  // do is release the button and, on a refusal, park the reason for the card's
  // `ArcPressNoticeController`. Success needs no voice: the wheel opening or
  // ending the stage is the answer.
  //
  // Registered from one table rather than six hand-written handlers, because
  // the three verbs differ in exactly one word and a copy of the pair is a
  // place for them to drift apart.
  for (const [action, verb] of [
    ["arc_run", "start"],
    ["arc_resume", "resume"],
    ["arc_stop", "stop"],
  ] as const) {
    registerAction(`${action}_ok`, (payload) => {
      const arc = payload.arc;
      if (typeof arc !== "string" || arc.length === 0) return;
      arcPressStore.settle(arc, verb);
      const sessionId = payload.tug_session_id;
      // A press that landed is not still a failure.
      if (typeof sessionId === "string" && sessionId.length > 0) {
        arcPressStore.clearRefusal(sessionId);
      }
    });

    registerAction(`${action}_err`, (payload) => {
      console.warn(`${action} failed`, payload);
      const sessionId = payload.tug_session_id;
      const arc = payload.arc;
      if (typeof arc !== "string" || arc.length === 0) return;
      // **Routable means a card actually holds it**, not merely that the
      // payload named something. An empty id is the obvious case; the one that
      // bites is a *non-empty* id no card wears, which is what a
      // segment-addressed refusal is on any rotated arc — waved straight
      // through by a length check into a store slot `ArcPressNoticeController`
      // never reads. `cardIdForSession` is the deck's own segment → line →
      // card walk, the same question `unbind_arc_ok` below asks.
      //
      // Either way the store releases the button, and a null id falls back to
      // the card the press was made from: a button left waiting on a frame
      // nobody can speak is worse than a silent refusal, and a refusal nobody
      // can speak is worse than one spoken where the press was.
      const named =
        typeof sessionId === "string" && sessionId.length > 0
          ? sessionId
          : null;
      const routable = named !== null && cardIdForSession(named) !== null;
      arcPressStore.refuse(
        routable ? named : null,
        arc,
        verb,
        typeof payload.reason === "string" ? payload.reason : "unknown",
      );
    });
  }

  // The store tails' answers: the shell's, and each body's too.
  registerStoreTailActions();

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

  // session_index_changed: some instance on this machine wrote the shared
  // session index. The two answers that could have become wrong are the
  // misses and the foreign findings, so those are dropped and the next
  // repaint asks again. Pushed by a watch rather than polled — the frame IS
  // the event, and there is no timer anywhere on either side of it.
  registerAction("session_index_changed", () => {
    sessionCitationStore.forgetUnsettled();
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
        // Exact id first, then by **line**. A question asked from inside a
        // stage names the segment the asking shell was spawned under, and the
        // Wheel rotates a card's session on purpose — so an exact match can
        // find no card while the conversation is right there. An ask that
        // finds no card is answered by the declining fallback with nobody
        // asked, which is the silent failure this closes.
        // `cardIdForSession` is the deck's existing segment → line → card
        // walk; the direct match stays for a segment whose line no frame has
        // named this run.
        const services =
          cardServicesStore.getByTugSessionId(tugSessionId) ??
          (() => {
            const cardId = cardIdForSession(tugSessionId);
            return cardId === null ? null : cardServicesStore.getServices(cardId);
          })();
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

/**
 * The answers the connection-scoped stores' first requests wait on — the
 * session listing, a session's state changes, the digest's and the
 * Overview's ledger tails — each published to the store that asked.
 *
 * Every page that attaches those stores registers these, which is the shell
 * (from {@link initActionDispatch}) and every body (`body/body-main.ts`): a
 * page whose store asked and that answers none of them holds the live frames
 * and never the page before them, so a body's Overview showed no posts.
 */
export function registerStoreTailActions(): void {
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
      // A listing row is one **line** ([P06]): `session_id` is the segment a
      // resume would seat, and the identity on it is the line's.
      const lineId =
        row.line_id.length > 0 ? row.line_id : identityKeyForSession(row.session_id);
      sessionLineStore.seat(row.session_id, lineId);
      sessionNameStore.seedName(lineId, row.name_user_set ? row.name : null);
      // Seed the chip's tag cache from the listed rows so a bound session reads
      // its ledger tag once listed (or re-resumed after a legacy backfill).
      sessionTagStore.seedTag(lineId, row.tag);
      sessionSynopsisStore.seedSynopsis(lineId, row.synopsis);
    }
    publishListSessionsOk({
      project_dir: projectDir,
      sessions: rows,
      dir_exists: dirExists,
      scanning,
    });
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

  // list_digest_lines_ok: response to the digest-store's app-scoped
  // ledger-tail request. Lines are oldest-first; an empty ledger is a
  // valid empty array.
  registerAction("list_digest_lines_ok", (payload) => {
    const lines = payload.lines;
    if (!Array.isArray(lines)) {
      console.warn("list_digest_lines_ok: missing or invalid lines", payload);
      return;
    }
    publishListDigestLinesOk({ lines: lines as DigestLineWireRow[] });
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
}
