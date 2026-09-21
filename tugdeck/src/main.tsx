// CSS HMR boundary — all CSS side-effect imports are consolidated in css-imports.ts,
// which self-accepts HMR updates so CSS changes never trigger a full page reload here.
import "./css-imports";

import initTugmark from "../crates/tugmark-wasm/pkg/tugmark_wasm.js";
import wasmUrl from "../crates/tugmark-wasm/pkg/tugmark_wasm_bg.wasm?url";
import { TugConnection } from "./connection";
import { installDomForensics } from "./lib/dom-forensics";
import { setConnection } from "./lib/connection-singleton";
import { TugbankClient } from "./lib/tugbank-client";
import { setTugbankClient } from "./lib/tugbank-singleton";
import { DeckManager, type TerminationVerdict } from "./deck-manager";
import { dispatchAction, initActionDispatch } from "./action-dispatch";
import type { DeckState } from "./layout-tree";
import { initHostMenuState } from "./lib/host-menu-state";
import { getSettings } from "./lib/maker-mode-bridge";
import {
  IMPOSITION_GAP_BOTTOM_PROPERTY,
  impositionGapBottomPx,
  RAIL_EDGE_INSET_PROPERTY,
  RAIL_EDGE_INSET_PX,
  RAIL_GUTTER_PROPERTY,
  RAIL_GUTTER_PX,
  setImpositionGapBottom,
} from "./lib/layout-imposer";
import { initRecentDocuments } from "./lib/recent-documents";
import { installActivationClickBridge } from "./lib/activation-click-bridge";
import { installUpdateBridge } from "./lib/update-bridge";
import { cardServicesStore } from "./lib/card-services-store";
import { restoreSessions, restoreSpaceSessions } from "./lib/session-restore";
import { installDeckSeatingsReporter } from "./lib/deck-seatings-reporter";
import { attachSessionLedgerStore } from "./lib/session-ledger-store";
import { attachSessionStateChangesStore } from "./lib/session-state-changes-store";
import { attachDigestStore } from "./lib/digest-store";
import { attachOverviewStore } from "./lib/overview-store";
import { attachSessionActivityStore } from "./lib/session-activity-store";
import {
  attachChangesetAllStore,
  getChangesetAllStore,
} from "./lib/changeset-all-store";
import { attachChangesetVerbStore } from "./lib/changeset-verb-store";
import { attachChangesetDraftStore } from "./lib/changeset-draft-store";
import { attachChangesetJoinStore } from "./lib/changeset-join-store";
import { cardSessionBindingStore } from "./lib/card-session-binding-store";
import { transportStateStore } from "./lib/transport-state-store";
import {
  ConnectionLifecycle,
  registerConnectionLifecycle,
} from "./lib/connection-lifecycle";
import { readLayout, readTheme, readCardStates, readDeckState, readKeyboardAccess, readFocusRingModality, pruneOrphanedCardDefaults } from "./settings-api";
import { keyboardAccessStore, normalizeKeyboardAccessMode } from "./keyboard-access-store";
import { KEYMAP_DOMAIN, keymapOverrideStore } from "./keymap-override-store";
import { focusRingModalityStore, normalizeFocusRingModality } from "./focus-ring-modality-store";
import { getThemeSetter } from "./action-dispatch";
import {
  sendCanvasColor,
  activateProductionTheme,
  syncDevActiveTheme,
  readHostCanvasColorFromAppliedCss,
} from "./contexts/theme-provider";
import { BASE_THEME_NAME } from "./theme-constants";
import { registerHelloWorldCard } from "./components/tugways/cards/hello-world-card";
import { registerSessionCard } from "./components/tugways/cards/session-card-registration";
import { registerAboutCard } from "./components/tugways/cards/about-card";
import { registerSettingsCard } from "./components/tugways/cards/settings-card";
import { registerKeyboardCard } from "./components/tugways/cards/keyboard-card";
import { registerDevtoolsCard } from "./components/devtools/devtools-card";
import { registerJotsCard } from "./components/jots/jots-card-registration";
import { registerOverviewCard } from "./components/overview/overview-card-registration";
import { registerCardsCard } from "./components/cards/cards-card-registration";
import { registerLayoutCard } from "./components/layout/layout-card-registration";
import { registerArcsCard } from "./components/arcs/arcs-card-registration";
import { registerTextCard } from "./components/tugways/cards/text-card-registration";
import { registerFileViewCard } from "./components/tugways/cards/file-view-card-registration";
import { registerDiffCard } from "./components/tugways/cards/diff-card";
import { registerCommitCard } from "./components/tugways/cards/commit-card";
import { registerGalleryCards } from "./components/tugways/cards/gallery-registrations";
import { registerSpikeCards } from "./spikes/spike-registry";
import { registerFixtureCards } from "./fixtures/fixture-registrations";
import { tugDevLogStore } from "./lib/tug-dev-log-store/tug-dev-log-store";
import {
  animationCensus,
  getPerfMonitorSnapshot,
  layerTreeProbe,
  mutationCensus,
  readWakerCensus,
  startPerfMonitor,
  startWakerCensus,
  stopWakerCensus,
} from "./lib/perf-monitor";
import { initMotionObserver } from "./components/tugways/scale-timing";
import { initThemeTokens } from "./theme-tokens";
import { FONT_STACKS } from "./lib/editor-settings-store";
import { deserialize } from "./serialization";
import { attachTugTestSurface } from "./test-surface";
import { installHmrBridge } from "./hmr-bridge";
import { installDevErrorOverlay } from "./dev-error-overlay";

// Replace Vite's built-in HMR error overlay (disabled via
// `server.hmr.overlay = false`) with a viewport-fitting one. Installed
// at module scope, before the async boot IIFE, so a compile error that
// fires during startup is still reported. No-op in production.
installDevErrorOverlay();

/**
 * `window.tugdeck` — the single namespace the native Swift host uses
 * for its direct JavaScript entry points: the synchronous
 * `evaluateJavaScript` ones and the awaited `prepareForTermination`,
 * which the host calls through `callAsyncJavaScript` at quit. Only the
 * methods installed below live here. Typed via `declare global` so
 * consumers get IDE autocomplete and so the assignment below is a
 * straightforward `window.tugdeck = { ... }` rather than a cast
 * through `Record<string, unknown>`.
 */
declare global {
  interface Window {
    tugdeck?: {
      saveState(): void;
      /**
       * The deck's half of an application quit: interrupt live turns and
       * wait for them, capture and persist every card (including text held
       * outside the composer), retry rejected writes, and resolve a verdict
       * describing what actually landed. The host awaits this before it
       * signals any child process, and logs the verdict.
       *
       * `saveState` remains as the degraded fallback for a host that
       * cannot make this call.
       */
      prepareForTermination(): Promise<TerminationVerdict>;
      reconnect(): void;
      /**
       * Diagnostic surface — always available, no test-mode gate. Lets
       * a developer paste one-liners into DevTools without knowing the
       * DeckManager internals.
       */
      diag: {
        listCardIds(): string[];
        getDeckState(): unknown;
        getSpaces(): unknown;
        getCardState(cardId: string): unknown;
        captureCardState(cardId: string): unknown;
        registeredComponentKeys(cardId: string): string[];
      };
      /**
       * Measurement surface — the two write-capable moves a profiling
       * session needs to stand up a scenario on a build it cannot run
       * the DEBUG test harness against. See the attach site for why
       * this is here and what it does not widen.
       */
      lab: {
        dispatch(action: string, payload?: Record<string, unknown>): void;
        seedDeck(state: unknown, focusCardId?: string): void;
        createSpace(name?: string): string;
        renameSpace(spaceId: string, name: string): void;
        duplicateSpace(spaceId: string): string | null;
        deleteSpace(spaceId: string): boolean;
        reorderSpaces(order: readonly string[]): void;
        spaceHoldsLiveSessions(spaceId: string): number;
        moveCardToSpace(cardId: string, spaceId: string): boolean;
      };
    };
    /**
     * DEBUG-only harness boot flag. When `true`, tugdeck constructs
     * `DeckManager` with `testMode: true` — no tugbank reads, no
     * tugbank writes, state sourced exclusively from `seedDeckState`.
     * Set by a `WKUserScript` injected at `atDocumentStart` in
     * DEBUG builds when the Swift host starts with
     * `TUGAPP_TEST_SOCKET` set ([D08]). Release builds never reach
     * this path because the WKUserScript is gated by `#if DEBUG`.
     */
    __tugTestMode?: boolean;
    /**
     * DEBUG-only escape hatch on test-mode's persistence bypass.
     * When `true` AND `__tugTestMode` is also `true`, tugdeck still
     * skips the boot-time tugbank reads (so `seedDeckState` remains
     * the source of state truth) but the `put*Guarded` wrappers
     * actually issue their tugbank writes instead of short-circuiting.
     *
     * Used by cold-boot harness tests ([AT0014] / focus round-trips)
     * that pair test-mode IPC with per-test `TUGBANK_PATH` isolation
     * — the temp DB makes the test-mode pollution prevention
     * redundant, and the writes are required for Phase A's "bag is
     * on disk" assertion.
     *
     * Set by a `WKUserScript` injected at `atDocumentStart` when
     * the Swift host starts with `TUGAPP_PERSIST_IN_TEST_MODE=1`.
     * Release builds never reach this path (`#if DEBUG`-gated).
     */
    __tugPersistInTestMode?: boolean;
    /**
     * DEBUG-only escape hatch on test-mode's boot-restore bypass.
     * When `true` AND `__tugTestMode` is also `true`, the
     * `DeckManager` constructor honors the tugbank-sourced boot
     * arguments (layout, card-state bags, focused card id) instead of
     * starting empty — the production cold-boot restore channel
     * (constructor deck restore → CardHost mount-time
     * `applyBagFocus`), which `seedDeckState`'s post-mount cache
     * merge cannot drive. Quit-and-relaunch tests pair this with
     * `__tugPersistInTestMode` and a per-test `TUGBANK_PATH`.
     *
     * Set by a `WKUserScript` injected at `atDocumentStart` when the
     * Swift host starts with `TUGAPP_RESTORE_IN_TEST_MODE=1`.
     * Release builds never reach this path (`#if DEBUG`-gated).
     */
    __tugRestoreInTestMode?: boolean;
  }
}

// DOM forensics FIRST, before a connection is opened or a card is mounted.
// The three throwing DOM mutators are wrapped here so that any
// `NotFoundError` — from React's commit, from an imperative renderer, from
// anywhere — arrives naming the actual parent and child instead of thirty
// frames of minified recursion, and lands on disk before the user clicks
// Reload. See `lib/dom-forensics.ts` for the fault that made this
// necessary.
installDomForensics();

// Determine WebSocket URL from current page location
const wsUrl = `ws://${window.location.host}/ws`;

// Create connection (module scope — must be synchronous)
export const connection = new TugConnection(wsUrl);

// Construct the connection-lifecycle event pipe and attach it to the
// connection BEFORE `connection.connect()` runs below, so the very first
// handshake fires `connectionDidOpen` through the lifecycle. Register it
// as the module singleton for non-React subscribers (mirrors AppLifecycle's
// `registerAppLifecycle` pattern).
export const connectionLifecycle = new ConnectionLifecycle();
connection.setLifecycle(connectionLifecycle);
registerConnectionLifecycle(connectionLifecycle);

// Re-probe Claude login on every RECONNECT. tugcast answers with
// `claude_auth_result`, which feeds the app-level `authStore`. The probe is
// imperative/transition-driven (not a component effect) per [L02]/[L24] —
// `ConfigureTug` purely reads the store. Reconnect only: the FIRST connect fires
// `connectionDidOpen` before `initActionDispatch` registers the
// `claude_auth_result` handler, so the initial probe is sent after that
// registration instead (see below) — otherwise the answer races ahead of its
// handler and is dropped.
connectionLifecycle.observeConnectionDidReconnect(() => {
  connection.sendControlFrame("check_auth");
  connection.sendControlFrame("check_claude_version");
  connection.sendControlFrame("check_host_tools");
});

// Feed the app-wide transport-state store from the same lifecycle pipe. This is
// the channel ConfigureTug reads to show a calm "Reconnecting…" body instead of a
// dead wizard when the wire drops mid-setup ([L02]; arc/archive/onboarding-and-install.md#tugsetup-states).
connectionLifecycle.observeConnectionDidOpen(() => {
  transportStateStore.set("online");
});
connectionLifecycle.observeConnectionDidEnterReconnecting(() => {
  transportStateStore.set("reconnecting");
});
connectionLifecycle.observeConnectionDidClose(() => {
  transportStateStore.set("offline");
});

// Register connection in the singleton so modules that cannot safely import
// from main.tsx (due to circular dependency risk) can access it via getConnection().
setConnection(connection);

// Create TugbankClient — registers for DEFAULTS frames on this connection.
// Must be created before connect() so it receives the initial snapshot frame.
const tugbankClient = new TugbankClient(connection);
setTugbankClient(tugbankClient);

// Get the deck container from the DOM (module scope — must be synchronous)
const container = document.getElementById("deck-container");
if (!container) {
  throw new Error("deck-container element not found");
}

// Async IIFE: wait for tugbank data + WASM before constructing DeckManager.
//
// Initialization sequence:
//   1. Connect WebSocket (triggers tugcast to push DEFAULTS frame with all domains)
//   2. Wait for TugbankClient.ready() + WASM init in parallel
//   3. Read layout, theme, deck state from TugbankClient cache (synchronous)
//   4. Deserialize layout, read per-card state from cache (synchronous)
//   5. Construct DeckManager with all data
(async () => {
  // Connect first — this triggers the DEFAULTS frame push from tugcast.
  connection.connect();

  // Wait for initial DEFAULTS frame + WASM init in parallel.
  await Promise.all([
    tugbankClient.ready(),
    initTugmark({ module_or_path: wasmUrl }),
  ]);

  // All domain snapshots are now in the TugbankClient cache.
  // Read everything synchronously.
  const layout = readLayout(tugbankClient);
  const theme = readTheme(tugbankClient);
  const focusedCardId = readDeckState(tugbankClient);

  const initialTheme = theme ?? BASE_THEME_NAME;

  // Seed the keyboard-access mode from the DEFAULTS snapshot and stamp
  // `data-keyboard-access` on the document root before first render, so the
  // mode is correct from first paint (no flash of the wrong mode) — the same
  // before-paint discipline as the theme.
  keyboardAccessStore.initialize(
    normalizeKeyboardAccessMode(readKeyboardAccess(tugbankClient)),
  );

  // Seed the focus-ring modality from the DEFAULTS snapshot so the ring policy
  // is correct from the first key-view projection (no flash of the wrong ring).
  focusRingModalityStore.initialize(
    normalizeFocusRingModality(readFocusRingModality(tugbankClient)),
  );

  // Seed the user's keymap overrides, for the same reason and before the same
  // call: the host takes every menu key equivalent from the first menu-state
  // push, so an override that landed after it would show the user the default
  // chord they had already changed.
  keymapOverrideStore.initialize(tugbankClient.readDomain(KEYMAP_DOMAIN));

  // Startup theme reconciliation, before first render so the app does not
  // flash the wrong theme and then restyle.
  if (import.meta.env.PROD) {
    // Apply the saved non-base override <link>.
    await activateProductionTheme(initialTheme);
  } else {
    // Reconcile the dev server's baked active theme with this variant's saved
    // theme — the dev server's boot seed can come from a different tugbank
    // instance than this app writes to (see syncDevActiveTheme).
    await syncDevActiveTheme(initialTheme);
  }

  // Sync canvas color to Swift bridge from the applied CSS metadata token.
  const initialHostCanvasColor = readHostCanvasColorFromAppliedCss();
  if (initialHostCanvasColor !== null) {
    sendCanvasColor(initialHostCanvasColor);
  }

  // Capture the baseline sentinel for theme change detection.
  initThemeTokens();

  // Warm the editor font stacks now, once the @font-face rules are in
  // the document, so the first atom-chip bake (Canvas measurement +
  // label paint in tug-atom-img.ts) already has its faces decoded —
  // a not-yet-loaded face silently falls back and the chip would need
  // a re-bake. The editor settings store re-warms on font changes.
  for (const stack of Object.values(FONT_STACKS)) {
    void document.fonts.load(`13px ${stack}`).catch(() => undefined);
  }

  // Initialize motion observer early so data-tug-motion attribute is set before
  // DeckManager construction. The cleanup function is intentionally not stored
  // here — the observer should live for the entire app lifetime.
  initMotionObserver();

  // Register card types before DeckManager construction so addCard("hello") works
  // from the first render.
  registerHelloWorldCard();
  registerSessionCard();
  registerAboutCard();
  registerSettingsCard();
  registerKeyboardCard();
  registerDevtoolsCard();
  // Every sidebar card must register unconditionally and before the deck
  // restores its layout, so its rail survives reload — `filterRegisteredCards`
  // drops panes whose only card's componentId is unregistered at load.
  registerJotsCard();
  registerOverviewCard();
  registerArcsCard();
  registerCardsCard();
  // Registration order is the order the Layout card lists its rows in.
  registerLayoutCard();
  registerTextCard();
  registerFileViewCard();
  registerDiffCard();
  registerCommitCard();
  registerGalleryCards();
  registerSpikeCards();
  registerFixtureCards();

  // Dev-build convenience: expose the log store on `window.tugDevLog`
  // so the WebKit Web Inspector console can drive the Log section without
  // a test-mode harness. Also attached under the in-app test harness
  // (`window.__tugTestMode`, injected only in DEBUG Swift builds) so
  // app-tests can drive the Log section against the prod `dist/` bundle
  // — production users (no DEV, no test mode) never get this branch.
  if (import.meta.env.DEV || window.__tugTestMode === true) {
    (window as unknown as { tugDevLog?: typeof tugDevLogStore }).tugDevLog =
      tugDevLogStore;
    // Main-thread health sentinel (long tasks + heartbeat drift →
    // counters + dev log). Dev/test builds only — production must not
    // carry the monitor's 1 Hz wakeup; see lib/perf-monitor.ts for the
    // budgets it guards.
    startPerfMonitor();
    // `?wakerCensus=1` arms the waker census before the deck boots. The
    // census only attributes registrations made after it starts, so a
    // timer armed during boot is invisible to a census started later —
    // an attribution session hard-reloads with this flag to see them.
    if (new URLSearchParams(window.location.search).get("wakerCensus") === "1") {
      startWakerCensus();
    }
    (
      window as unknown as {
        tugPerfMonitor?: {
          snapshot: typeof getPerfMonitorSnapshot;
          animationCensus: typeof animationCensus;
          layerTreeProbe: typeof layerTreeProbe;
          startWakerCensus: typeof startWakerCensus;
          readWakerCensus: typeof readWakerCensus;
          stopWakerCensus: typeof stopWakerCensus;
          mutationCensus: typeof mutationCensus;
        };
      }
    ).tugPerfMonitor = {
      snapshot: getPerfMonitorSnapshot,
      animationCensus,
      layerTreeProbe,
      startWakerCensus,
      readWakerCensus,
      stopWakerCensus,
      mutationCensus,
    };
  }
  // Extract card IDs from the loaded layout and read per-card state bags
  // from the tugbank cache (`dev.tugapp.deck.cardstate`).
  let cardStates = new Map<string, import("./layout-tree").CardStateBag>();
  if (layout !== null) {
    try {
      const parsed = deserialize(JSON.stringify(layout), 0, 0);
      // EVERY space's cards, not only the active one's ([P03]). A card in a
      // parked workspace restores from this cache at the moment its workspace
      // is activated — long after boot, and with no second read to fill it.
      const cardIds = parsed.spaces.flatMap((s) =>
        s.deck.cards.map((c) => c.id),
      );
      if (cardIds.length > 0) {
        cardStates = readCardStates(tugbankClient, cardIds);
      }
    } catch (e) {
      console.warn("[main] failed to read per-card states, continuing without", e);
    }
  }

  // DEBUG-only test-mode flag ([D02], [D08]). The Swift host injects
  // `window.__tugTestMode = true` via a `WKUserScript` at
  // `atDocumentStart` when `TUGAPP_TEST_SOCKET` is set at app launch.
  // That script is gated by `#if DEBUG` in
  // `tugapp/Sources/TestHarness/TestHarnessUserScript.swift`, so
  // production users never have the global set — making this read
  // safe regardless of build mode. The previous `import.meta.env.DEV`
  // co-gate was a belt-and-braces tree-shake hint; we drop it so the
  // in-app harness can run against a prod-built `dist/` (no Vite),
  // which is ~700ms faster on cold launch.
  const isTestMode = window.__tugTestMode === true;

  // Create deck manager with the pre-fetched layout, initial theme, card states,
  // and focused card ID. In test mode, `DeckManager` ignores the
  // tugbank-sourced arguments and starts empty — the harness drives
  // state via `seedDeckState`.
  const deck = new DeckManager(
    container,
    connection,
    layout ?? undefined,
    initialTheme,
    cardStates,
    focusedCardId ?? undefined,
    { testMode: isTestMode }
  );

  // Initialize action dispatch (no SessionNotificationRef in Phase 0).
  initActionDispatch(connection, deck);

  // Initial Claude-auth probe. Sent HERE — after initActionDispatch has
  // registered the `claude_auth_result` handler and the wire is already open
  // (tugbank ready was awaited above) — not on the first `connectionDidOpen`,
  // which fires before that handler exists. Without this, the answer arrives
  // unhandled and the auth gate never resolves. Reconnects re-probe via
  // `observeConnectionDidReconnect`.
  connection.sendControlFrame("check_auth");
  // …and the Claude Code version pair the wizard's install row reports
  // (installed here vs newest on the stable channel). Same timing rule as the
  // auth probe: sent after `initActionDispatch` registered its handler.
  connection.sendControlFrame("check_claude_version");

  // …and whether this machine carries a git Tug can use. Silent by
  // construction — see `host_tools`'s probe order — so it is safe to fire
  // before the user has seen anything. Same timing rule as the probes above.
  connection.sendControlFrame("check_host_tools");

  // The seating report: tugcast learns which sessions this deck has seated
  // on open Session cards, so the changeset never orphans an open card's
  // files during the startup-demote window. Same timing rule as the probes
  // above; the reporter subscribes to `cardSessionBindingStore` and handles
  // reconnects itself.
  installDeckSeatingsReporter(connection);

  // Wire the menuState host push: the aggregator subscribes to the
  // deck store and posts the menu-relevant projection to the Swift
  // host, which validates the menu bar from it. See
  // `lib/host-menu-state.ts` for the wire contract.
  initHostMenuState(deck);

  // Publish the rail's two lengths on the root. The imposer's own expressions
  // carry the numeric twins as fallbacks, so this write moves nothing they
  // draw; it is for the stylesheets, which can read a property and cannot
  // read a constant.
  document.documentElement.style.setProperty(
    RAIL_EDGE_INSET_PROPERTY,
    `${RAIL_EDGE_INSET_PX}px`,
  );
  document.documentElement.style.setProperty(
    RAIL_GUTTER_PROPERTY,
    `${RAIL_GUTTER_PX}px`,
  );

  // Settle the imposition's bottom band from the host's build profile. A
  // maker's canvas reserves depth at the foot for the host's dev-info stamps;
  // a release build draws none, so it keeps the same air there as at the other
  // three edges. The fact arrives one round trip after boot, so the deck
  // re-imposes when it lands and only when the answer differs from the maker
  // depth every expression already falls back to.
  void getSettings().then((settings) => {
    if (!setImpositionGapBottom(settings?.makerMode === true)) return;
    document.documentElement.style.setProperty(
      IMPOSITION_GAP_BOTTOM_PROPERTY,
      `${impositionGapBottomPx()}px`,
    );
    deck.retuneSidebarAllocation();
  });

  // Seed the Open Recent list from tugbank and mirror it to the host.
  // After initHostMenuState (the publisher exists) and after tugbank
  // ready (its cache is populated), so the first push carries the
  // persisted MRU.
  initRecentDocuments();

  // Receive the host's "an update is available" push and announce it as a
  // bulletin. Installed after the provider tree is mounted so the first
  // push has a Toaster to land in. See `lib/update-bridge.ts`.
  installUpdateBridge();

  // Receive the host's click-through activation point: the click that brings a
  // backgrounded Tug.app forward never reaches the document, so the host hands
  // its location here and the deck activates the pane/card under it. Installed
  // after the deck is mounted so the gesture interpreter is live.
  // See `lib/activation-click-bridge.ts`.
  installActivationClickBridge();

  // Install `window.__tug` test-harness surface when
  // `window.__tugTestMode === true`. The attach is a no-op otherwise;
  // production users never have the global set, since the
  // `WKUserScript` that injects it is `#if DEBUG`-gated in
  // `tugapp/Sources/TestHarness/TestHarnessUserScript.swift`.
  // See `test-surface.ts` for the full surface and attach-site rationale ([D03]/[D08]).
  attachTugTestSurface(deck);

  // Install the Vite-HMR bridge so React Fast Refresh remounts (the
  // dev-only fifth and sixth "known transitions" beyond tab-switch /
  // saveState / beforeunload / close-before-destroy) trigger the
  // same iterate-and-save pass as `beforeunload`. The bridge is a
  // no-op in production — `import.meta.hot` is `undefined` in
  // shipped bundles. See `hmr-bridge.ts` for the full rationale and
  // the [L23] preservation contract this extension honors.
  installHmrBridge(deck);

  // Wire the per-card services store to the deck-manager so it can
  // detect card removals and send `close_session` for any held
  // bindings. Per [L10] this keeps the deck-canvas card-type-agnostic:
  // user-close gestures flow through deck-manager.removeCard, and the
  // services store reacts on its own.
  cardServicesStore.attachDeckManager(deck);

  // Sweep durable card-state bags for cards no longer in the deck. The
  // close path flushes a card's last bag to tugbank but never deletes it,
  // so orphaned bags would accumulate unbounded across the app's life —
  // the leak that bloated the cardstate domain to 18 MB and stalled the
  // boot DEFAULTS frame. Fire-and-forget, post-mount.
  //
  // SKIPPED in test mode. There, `DeckManager` boots empty by design —
  // the harness drives state via `seedDeckState` *after* this point — so
  // `deck.getSnapshot().cards` is empty here and the sweep would treat
  // EVERY persisted bag as orphaned and delete it. That wipes exactly
  // the cardstate a reload/relaunch test persisted in its first launch
  // and expects to read on the next boot, turning real persistence into
  // a false negative. Production always boots with its persisted layout,
  // so its live-set is correct and the sweep stays meaningful there.
  if (!isTestMode) {
    pruneOrphanedCardDefaults(
      tugbankClient,
      // Every space's cards ([P03], Table T01). The active deck alone would
      // read every parked workspace's cards as orphaned and delete their bags.
      deck.allSpaceCardIds(),
    );
  }

  // Wire the dev session-ledger store to the connection. The store
  // dispatches `list_sessions` requests on first observation, subscribes
  // to `session_updated` push frames, and invalidates on reconnect. The
  // picker reads via `useSessionLedger(workspaceKey)` (step 5).
  attachSessionLedgerStore(connection);

  // Wire the per-session state-change store to the connection. Without
  // this the singleton is never created — `useSessionStateChanges`
  // finds no active store and the Z2 STATE popover renders a permanent
  // "no state changes recorded yet", even though the supervisor's
  // ledger holds the rows. The store dispatches
  // `list_session_state_changes` on first observation of a session and
  // appends live triple transitions from the local pub/sub bus.
  attachSessionStateChangesStore(connection);

  // Wire the app-scoped digest store: one `list_digest_lines` tail
  // fetch on first observation, live `DIGEST` frames folded after.
  // The Z2 strip reads it via `useDigest`.
  attachDigestStore(connection);

  // Wire the app-scoped OVERVIEW store: one `list_overview_posts` tail
  // fetch on first observation, live `OVERVIEW` frames folded after.
  // The Overview card reads it via `useOverview`.
  attachOverviewStore(connection);

  // Wire the app-scoped ACTIVITY store: one subscription to the
  // per-session activity feed ([P01]), routed by each frame's own
  // `tug_session_id`. The Z2 sparkline reads its `compositeSeries`.
  attachSessionActivityStore(connection);

  // Wire the account-global changeset store: the aggregate CHANGESET_ALL
  // feed (every open project in one frame). The changeset card reads it via
  // `useChangesetAll` — no workspace filter, unlike the per-card feeds.
  attachChangesetAllStore(connection);

  // Wire the changeset CONTROL-verb round-trip store (M02A: changeset_git_init
  // for the non-repo "Initialize git" affordance). The card reads it via
  // `useChangesetGitInit`.
  attachChangesetVerbStore(connection);
  // Wire the maintained-draft overlay store ([P24]): live streaming text +
  // freshness for the changeset card's draft panel, read via `useChangesetDraft`.
  attachChangesetDraftStore(connection);
  // Wire the arc-join resolve overlay store (Spec S12, [P31]/[P32]): the
  // /btw-style resolution progress + result, read via `useChangesetJoinResolve`.
  const joinStore = attachChangesetJoinStore(connection);
  // …and let the aggregate feed settle it ([P02]). The overlay holds a run;
  // what the run produced comes back on the arc's entry, so the recompute is
  // what ends it — a reply frame only ends it sooner. Drained once here for the
  // snapshot the store already holds, the way `ChangesetAllStore` drains its
  // own feed at attach.
  const changesetAll = getChangesetAllStore();
  if (changesetAll !== null) {
    changesetAll.subscribe(() =>
      joinStore.observeFeed(changesetAll.getSnapshot()),
    );
    joinStore.observeFeed(changesetAll.getSnapshot());
  }

  // Re-assert session bindings for dev cards that were alive before
  // this page reload. The deck layout is materialized;
  // `restoreSessions` sends a `list_card_bindings` CONTROL request
  // (the server reads from its sqlite ledger) and emits
  // `spawn_session(mode=resume)` per matching card. The server's ack
  // populates `cardSessionBindingStore`, which flips each card from
  // picker to bound body before `cardDidActivate` fires for any of
  // them.
  restoreSessions(deck, connection);

  // …and the same pass, per workspace, at the moment one is activated ([B04],
  // [P08]). The boot pass above covers the ACTIVE workspace only; a parked
  // one's cards are restored when the user switches to it, which is what keeps
  // ten workspaces from spawning ten sets of tugcode at launch. The hook fires
  // inside `activateSpace`, before React mounts the incoming cards, so a
  // restoring card never flashes its picker first.
  deck.setSpaceRestoreHook((spaceDeck) => {
    restoreSpaceSessions(deck, spaceDeck, connection);
  });

  // Reconnect path: every WebSocket recovery from a close re-runs the
  // restore loop so cards rebind without a page reload after a tugcast
  // restart. The order — clearAll, then re-restore — is per [D04] in
  // arc/tugplan-session-connection-health.md: bindings the client
  // still holds against a now-dead server are worse than no bindings,
  // because they would route frames the new server is not emitting.
  //
  // `connectionDidReconnect` (vs `connectionDidOpen`) is the right event
  // here: it fires only when the wire recovered from a prior close,
  // never on the initial app-boot open. The lifecycle layer maintains
  // the close-then-open gating so this subscriber never has to.
  connectionLifecycle.observeConnectionDidReconnect(() => {
    cardSessionBindingStore.clearAll();
    restoreSessions(deck, connection, {
      reason: "reconnect",
    });
  });

  // React to live tugbank changes pushed via the DEFAULTS WebSocket feed.
  // When an external process writes to tugbank (e.g., `tugbank write ... theme harmony`),
  // the TugbankClient cache updates and this callback fires.
  //
  // Guard: only call the setter if the theme actually changed. Without this,
  // setTheme → putTheme → tugbank write → DEFAULTS push → onDomainChanged → setTheme
  // creates an infinite loop of CSS HMR updates.
  let currentTheme = initialTheme;
  tugbankClient.onDomainChanged((domain, entries) => {
    // Keymap overrides written from another process (a second window, or
    // `tugbank write … dev.tugapp.keymap`). The keymap registry republishes
    // the menu-state block on any binding change, so the native key
    // equivalents follow without a second channel — the same shape the stack
    // chord already uses.
    if (domain === KEYMAP_DOMAIN) {
      keymapOverrideStore.applyRemote(entries);
      return;
    }
    if (domain === "dev.tugapp.app") {
      const themeEntry = entries["theme"];
      if (themeEntry && themeEntry.kind === "string" && typeof themeEntry.value === "string") {
        if (themeEntry.value !== currentTheme) {
          currentTheme = themeEntry.value;
          const setter = getThemeSetter();
          if (setter) setter(currentTheme);
        }
      }
      // Keyboard-access mode pushed from another process (e.g. the Swift host
      // menu, or `tugbank write … keyboardAccess accessibility`). Apply with
      // persist:false to avoid echoing the write back through tugbank.
      const kbEntry = entries["keyboardAccess"];
      if (kbEntry && kbEntry.kind === "string" && typeof kbEntry.value === "string") {
        keyboardAccessStore.setMode(
          normalizeKeyboardAccessMode(kbEntry.value),
          { persist: false },
        );
      }
      // Focus-ring modality pushed from another process (e.g.
      // `tugbank write … focusRingModality pointer`). Apply with persist:false
      // to avoid echoing the write back through tugbank.
      const ringEntry = entries["focusRingModality"];
      if (ringEntry && ringEntry.kind === "string" && typeof ringEntry.value === "string") {
        focusRingModalityStore.setMode(
          normalizeFocusRingModality(ringEntry.value),
          { persist: false },
        );
      }
    }
  });

  // `window.tugdeck` — the single namespace the native app (Swift) uses
  // for synchronous evaluateJavaScript entry points. Only two methods
  // live here, both driven from the Swift host:
  //
  //   - `saveState()` — triggers `DeckManager.saveAndFlushSync()` before
  //     WebView teardown on app quit. Synchronous XHR so all writes
  //     complete before evaluateJavaScript returns. Called from
  //     `applicationShouldTerminate` — WKWebView doesn't fire
  //     visibilitychange or beforeunload on quit, so this is the only
  //     reliable save-on-quit path.
  //   - `reconnect()` — forces a WebSocket reconnection. Called after
  //     silent re-authentication when tugcast restarts.
  //
  // App lifecycle events (become-active / resign-active / hide / unhide)
  // ride the `app-lifecycle` control frame instead, routed through
  // `action-dispatch.ts` to the `AppLifecycle` singleton. The
  // control-frame path is preferred; only these stay as
  // evaluateJavaScript entry points because they're synchronous
  // Swift-initiated RPCs where a WebSocket round-trip is the wrong
  // timing.
  window.tugdeck = {
    saveState: () => deck.saveAndFlushSync(),
    prepareForTermination: () => deck.prepareForTermination(),
    reconnect: () => connection.forceReconnect(),

    /**
     * Diagnostic surface — always available, no test-mode gate. Lets
     * a developer paste one-liners into DevTools without knowing the
     * DeckManager internals. Every method here is read-only: it
     * observes DOM and reads the deck snapshot.
     *
     * Security note. This surface assumes the document context is
     * trusted (Tug.app loads its own bundle into a same-origin
     * WKWebView; the dev server is loopback-bound). The methods
     * return full deck state and any card's bag. Do not expose
     * `tugdeck` to untrusted iframes or cross-origin contexts —
     * `getDeckState` would become an exfiltration channel.
     */
    diag: {
      /** Card ids currently in the deck, in z-order (last = top). */
      listCardIds: () => deck.getSnapshot().cards.map((c) => c.id),
      /** Full active state — for ad-hoc inspection only. */
      getDeckState: () => deck.getSnapshot(),
      /**
       * Every space — its id, name, whether it is active, and its deck ([P03]).
       * The active space's deck is the live one `getDeckState()` returns; the
       * rest are parked. Read-only, which is what keeps it in `diag`.
       */
      getSpaces: () => {
        const snapshot = deck.getSpacesSnapshot();
        return {
          activeSpaceId: snapshot.activeSpaceId,
          spaces: snapshot.spaces.map((s) => ({
            id: s.id,
            name: s.name,
            active: s.id === snapshot.activeSpaceId,
            deck: deck.getSpaceDeck(s.id),
          })),
        };
      },
      /** The bag currently in the cardStateCache for `cardId`. */
      getCardState: (cardId: string) => deck.getCardState(cardId),
      /**
       * Capture the bag for `cardId` right now via the orchestrator —
       * same code path every save trigger runs. Use to verify what
       * the framework would write if a save fired at this moment.
       * Does NOT write to the store or to tugbank.
       */
      captureCardState: (cardId: string) => deck.captureCardState(cardId),
      /**
       * Scoped keys currently registered in `cardId`'s component-state
       * preservation registry. Empty array when no registry exists or
       * no consumers have registered.
       */
      registeredComponentKeys: (cardId: string) => {
        const reg = deck.peekComponentStatePreservationRegistry(cardId);
        return reg ? Array.from(reg.keys()) : [];
      },
    },

    /**
     * Measurement surface — the two write-capable moves a profiling
     * session needs, and nothing else.
     *
     * A performance question about a shipped surface has to be asked of
     * a RELEASE build: a debug build's timings are not the product's,
     * and the perf program's discipline says so outright. But the app
     * test harness cannot reach a release build — `window.__tug` is
     * installed only when `__tugTestMode` is set, and the
     * `WKUserScript` that sets it is `#if DEBUG`-gated in
     * `TestHarnessUserScript.swift`, so no runtime opt-in can open it.
     * That left release measurable only by hand: stand up a deck
     * through the UI, then drive the gesture through the UI, with the
     * scenario differing run to run. These two methods make a release
     * scenario scriptable and therefore repeatable, which is what makes
     * an interleaved A/B mean anything.
     *
     * Both are deliberately thin: `dispatch` is the same entry point
     * every menu item and every control in the app already calls, and
     * `seedDeck` is `DeckManager.seedDeckState`, which is documented as
     * callable outside test mode and issues no tugbank I/O of its own.
     * Neither is a parallel code path — a scripted scenario exercises
     * exactly what a user's gesture would.
     *
     * On what this does and does not widen. It adds no REMOTE reach:
     * the remote door is `POST /api/eval`, which stays shut behind the
     * `diag/eval` tugbank default and is unchanged here. In-page, the
     * trust assumption is the one `diag` above already states — Tug.app
     * loads its own bundle into a same-origin `WKWebView` — and page
     * script could already drive any of this by synthesizing clicks on
     * real controls. What is new is convenience for a developer who has
     * already opened that door, not a door.
     */
    lab: {
      /** Run a control action exactly as a menu item or control would. */
      dispatch: (action: string, payload?: Record<string, unknown>) => {
        dispatchAction({ ...payload, action });
      },
      /**
       * Replace the deck's state wholesale. The caller passes a
       * fully-formed `DeckState`; there is no merge with what was
       * there. Used to stand a known scenario up before measuring it.
       */
      seedDeck: (state: unknown, focusCardId?: string) => {
        deck.seedDeckState({ state: state as DeckState, focusCardId });
      },
      /**
       * The workspace record verbs ([P05]–[P07]), thin. They exist here for
       * the same reason `dispatch` does: an app-test needs to drive New,
       * Rename, Duplicate, Delete and reorder before the Workspaces card's
       * surface exists to drive them with, and each of these is the one
       * method that surface will itself call.
       */
      createSpace: (name?: string) => deck.createSpace(name),
      renameSpace: (spaceId: string, name: string) => {
        deck.renameSpace(spaceId, name);
      },
      duplicateSpace: (spaceId: string) => deck.duplicateSpace(spaceId),
      deleteSpace: (spaceId: string) => deck.deleteSpace(spaceId),
      reorderSpaces: (order: readonly string[]) => {
        deck.reorderSpaces(order);
      },
      spaceHoldsLiveSessions: (spaceId: string) =>
        deck.spaceHoldsLiveSessions(spaceId),
      moveCardToSpace: (cardId: string, spaceId: string) =>
        deck.moveCardToSpace(cardId, spaceId),
    },
  };

  // Signal frontend readiness to native app.
  // This fires after theme is applied, canvas color is sent, and DeckManager is
  // constructed — so the WebView can be safely revealed without visual artifacts.
  // Subscribed via `connectionDidOpen` (not `connectionDidReconnect`) because
  // signalReady should also re-fire on every reconnect — the WebView host
  // tracks readiness per-connection.
  const signalReady = () => {
    const webkit = (window as unknown as {
      webkit?: {
        messageHandlers?: {
          frontendReady?: { postMessage: (v: unknown) => void };
        };
      };
    }).webkit;
    webkit?.messageHandlers?.frontendReady?.postMessage({});
  };
  signalReady();
  connectionLifecycle.observeConnectionDidOpen(signalReady);

  console.log("tugdeck initialized");
})();
