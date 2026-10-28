/**
 * CardServicesStore — module-scope owner of per-card service bags.
 *
 * The Session card needs a `CodeSessionStore`, an `EditorSettingsStore`,
 * and a couple of feed-store stacks. These have side effects on
 * construction (FeedStore subscribes to the wire, CodeSessionStore
 * registers an `onClose` on the connection). They cannot be created
 * during render and must outlive transient React effect re-runs.
 *
 * Earlier the lifecycle lived inside `useSessionCardServices` as
 * `useState<services>` populated by a `useLayoutEffect` keyed on the
 * binding. That violated [L02] (no `useEffect` copying external state
 * into React state) and produced a class of bugs where services tore
 * themselves down on a binding-field update, sent a stray
 * `close_session` frame to the supervisor, and remounted the picker
 * mid-session.
 *
 * This store is the structure-zone source of truth ([L24]). It
 * subscribes to `cardSessionBindingStore` *once* at module init,
 * constructs services when a binding for a `cardId` appears, and
 * disposes services when the binding for that `cardId` disappears.
 * React reads the resulting map via `useSyncExternalStore` ([L02]) —
 * services have a stable identity across React re-renders for the
 * lifetime of the binding.
 *
 * The wire `close_session` frame is **not** sent from this store: it
 * is sent explicitly by the deck-canvas when the user closes a card
 * (see `closeCard` below). The store reacts to the resulting binding
 * clear and disposes; the resume-failed unbind path clears the
 * binding without going through `closeCard`, so no spurious close
 * frame is sent to a supervisor session that has already torn down.
 */

import { createSubscribable } from "./subscribable";
import { CodeSessionStore, SETTLE_WAIT_BUDGET_MS } from "./code-session-store";
import { EditorSettingsStore } from "./editor-settings-store";
import { TranscriptSettingsStore } from "./transcript-settings-store";
import { SessionMetadataStore } from "./session-metadata-store";
import { FileTreeStore } from "./filetree-store";
import { ChangesRouteController } from "./changes-route-controller";
import { SkillsInventoryStore } from "./skills-inventory-store";
import { HooksInventoryStore } from "./hooks-inventory-store";
import { SideQuestionStore } from "./side-question-store";
import { RefsSessionStore } from "./refs-session-store";
import { ShellSessionStore } from "./shell-session-store";
import { PathCommandsStore } from "./path-commands-store";
import { ShellGrammarStore } from "./shell-grammar-store";
import { ShellClassifyStore } from "./shell-classify-store";
import { PendingContextStore } from "./pending-context-store";
import { FeedStore, type FeedStoreFilter } from "./feed-store";
import { FeedId } from "../protocol";
import type { CompletionProvider } from "./tug-text-types";
import { getConnection } from "./connection-singleton";
import { DEFAULT_REPLAY_WINDOW_TURNS } from "../protocol";
import { resolveRestoreWindow } from "./session-restore-window";
import {
  cancelRestoreRetry,
  clearOpeningCommand,
  clearQueuedSends,
  drainOpeningCommand,
  drainQueuedSends,
  stashQueuedSends,
} from "./session-restore-holds";
import { getConnectionLifecycle } from "./connection-lifecycle";
import { getTugbankClient } from "./tugbank-singleton";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "./card-session-binding-store";
import { sendCloseSession, sendRequestReplay } from "./session-lifecycle";
import { recordSessionRecentProject } from "../settings-api";
import type { DeckManager } from "../deck-manager";
import { logSessionLifecycle } from "./session-lifecycle-log";
import { runOpeningCommand } from "./opening-command-runner";
import { isDirectoryChangeRebind } from "./directory-change";
import { bodyCardsStore } from "./body-cards-store";
import { forgetPendingReload, type ReloadReason } from "./reload-reasons";
import { isHarnessSession } from "./harness-sessions";

export interface CardServices {
  /**
   * The session these services are bound to. Tracked so `_reconcile` can tell
   * a *different session on the same card* (a `/resume` to another session, or
   * a `/clear` fresh-spawn) apart from an unchanged binding — the trigger to
   * dispose and reconstruct with a fresh store. Stable for the bag's lifetime;
   * a rebind builds a new bag.
   */
  readonly tugSessionId: string;
  readonly codeSessionStore: CodeSessionStore;
  readonly editorStore: EditorSettingsStore;
  readonly transcriptStore: TranscriptSettingsStore;
  readonly sessionMetadataStore: SessionMetadataStore;
  readonly sessionMetadataFeedStore: FeedStore;
  readonly fileTreeStore: FileTreeStore;
  readonly fileTreeFeedStore: FeedStore;
  /**
   * Single-shot `/skills` request/response store ([#step-12d]), fed by the
   * session mirror's routed store for `skills_inventory` ([P14]). Fires
   * `skills_inventory_query` and resolves the matching tugcode response —
   * not a continuous subscription.
   */
  readonly skillsInventoryStore: SkillsInventoryStore;
  /**
   * Single-shot `/hooks` request/response store ([#step-12c]), fed by the
   * routed store for `hooks_inventory`.
   */
  readonly hooksInventoryStore: HooksInventoryStore;
  /**
   * `/btw` side-question store (Spec S02), fed by the routed store for
   * `side_question_answer`. Keeps an ephemeral ask/answer history;
   * overlay-only, never dispatched to the code-session store ([P05]). NOT a
   * `KNOWN_CODE_OUTPUT_TYPES` member, so the transcript never sees a side
   * question.
   */
  readonly sideQuestionStore: SideQuestionStore;
  /**
   * `$`-route shell session (Spec S01) and its `SHELL_OUTPUT` feed (filtered to
   * this session). Owns shell session state (`live`/`cwd`/in-flight) and
   * mirrors each exchange into `codeSessionStore.ingestShellExchange` — the
   * shell rows live in the transcript, not here ([P12]).
   */
  readonly shellSessionStore: ShellSessionStore;
  readonly shellSessionFeedStore: FeedStore;
  /**
   * `/match` and `/search` runs and their `REFS_OUTPUT` feed (filtered to this
   * session). Owns the run state and the latest ref list — the one `/ref N`
   * resolves against — and mirrors each run into
   * `codeSessionStore.ingestRefs`; the result rows live in the transcript,
   * not here.
   */
  readonly refsSessionStore: RefsSessionStore;
  readonly refsSessionFeedStore: FeedStore;
  /**
   * What the shell-line classifier tests membership against ([P08]): the
   * login-PATH set unioned with the session shell's own aliases, functions and
   * builtins. Shares the shell session's `SHELL_OUTPUT` feed; requested at
   * bind, null until the command-set reply lands.
   */
  readonly pathCommandsStore: PathCommandsStore;
  /**
   * The command-grammar grader tugcast serves over the same `SHELL_OUTPUT`
   * feed. Request-per-line rather than requested at bind, because what it
   * grades is the draft being typed.
   */
  readonly shellGrammarStore: ShellGrammarStore;
  readonly shellClassifyStore: ShellClassifyStore;
  /**
   * The `±`-route Changes controller ([P07]) — a filtered, selection-aware
   * projection over the app-level `ChangesetAllStore` (0x24) scoped to this
   * card's workspace + session. Opens NO feed of its own; `dispose`
   * unsubscribes it from the singleton.
   */
  readonly changesController: ChangesRouteController;
  /**
   * The per-card queue of shell / `/btw` interactions staged to ride the next
   * `❯` submission as attributed `<tug-context>` context. Consumed by
   * `codeSessionStore.send`; surfaced to the composer (staged-count hint) and
   * the shell / `/btw` rows (stage actions + queued badge).
   */
  readonly pendingContextStore: PendingContextStore;
  /**
   * The `@` file-completion provider. Captured once at construction
   * because each call to `FileTreeStore.getFileCompletionProvider()`
   * creates a new closure with its own dedup state — re-deriving it
   * per render would break query deduplication.
   */
  readonly fileCompletionProvider: CompletionProvider;
}

/** The dev transcript's scroll region key — matches `TugListView`'s
 *  `scrollKey="session-card-transcript"`. */
const TRANSCRIPT_SCROLL_KEY = "session-card-transcript";

/**
 * The longest a directory change holds the old transcript on screen waiting
 * for the new one. Measured at under 100 ms from the re-bind to the new
 * session's replay completing on a warm machine; a cold tugcode start on a
 * long session takes seconds (the resume preflight allows for five to ten),
 * and the limit has to outlast that. Past it the card shows the new session
 * as it stands: a move must never leave a card showing a session tugcast has
 * already closed.
 */
const HELD_SWAP_LIMIT_MS = 10_000;

/** A directory change's new bag, built and waiting to replace the shown one. */
interface HeldSwap {
  readonly services: CardServices;
  readonly release: () => void;
}

/**
 * Read the saved transcript anchor's `turnDepthFromEnd` (turns from the
 * anchored turn to the bottom) from the card's persisted bag, or `undefined`
 * when there's no usable anchor (fresh card, at-bottom save, legacy row-only
 * bag, or a cache miss before hydration). Drives faithful-restore window
 * sizing ([P06]); a miss falls back to the default window. A legacy bag that
 * carries only a row `depthFromEnd` is deliberately ignored here — feeding a
 * row distance into the turn-sized window is the unit mismatch #step-13
 * removes; such a bag simply resumes at the default window and its raw index
 * relocates the anchor.
 */
function readSavedAnchorTurnDepth(
  deckManager: DeckManager | null,
  cardId: string,
): number | undefined {
  // `getCardState?.()` guards both a null deck and a partial test stub that
  // omits the method.
  const region =
    deckManager?.getCardState?.(cardId)?.regionScroll?.[TRANSCRIPT_SCROLL_KEY];
  const meta = region?.meta as
    | { anchor?: { turnDepthFromEnd?: unknown } }
    | undefined
    | null;
  const depth = meta?.anchor?.turnDepthFromEnd;
  return typeof depth === "number" && depth > 0 ? depth : undefined;
}

class CardServicesStore {
  private readonly _services = new Map<string, CardServices>();
  /**
   * The opening-command runner each bag is carrying, by the bag's session
   * store, so the bag's teardown stops a run that never got to fire.
   */
  private readonly _openingRuns = new Map<CodeSessionStore, () => void>();
  /**
   * Bags built for a directory change and not yet shown, by card. While one
   * is here the card keeps rendering the bag in `_services` — the session it
   * moved away from — so its transcript never empties; the swap publishes the
   * new bag once its replay is ready ([L02]: one notification, both maps).
   */
  private readonly _heldSwaps = new Map<string, HeldSwap>();
  /** {@link HELD_SWAP_LIMIT_MS}, shortened by tests that exercise the limit. */
  private _heldSwapLimitMs = HELD_SWAP_LIMIT_MS;
  /**
   * Each bag's transcript window, in turns, sized at construction from the
   * saved anchor; read when the bag's transcript is requested.
   */
  private readonly _restoreWindows = new WeakMap<CardServices, number>();
  /**
   * The bags whose transcript has been requested. A bag is read from disk at
   * most once: the request is what fills it, and a second one into a store
   * that already holds its transcript is the casual reload this store exists
   * to refuse. Each is kept with the reason it was read for, so a read the
   * wire cut short can be made again for the same one.
   */
  private readonly _transcriptRequested = new WeakMap<CardServices, ReloadReason>();
  private readonly _listeners = createSubscribable();
  private _bindingUnsub: (() => void) | null = null;
  private _deckUnsub: (() => void) | null = null;
  /** The attached deck, read at construct time for the saved scroll anchor
   *  (faithful restore window sizing, #step-6). */
  private _deckManager: DeckManager | null = null;
  private _initialized = false;
  /**
   * The one card this page shows, when the page is a body. A body page
   * mirrors other cards' bindings — every card an arrangement body lists,
   * the card a following body follows — and a mirrored binding is a fact
   * about another card, never a session for this page to drive: driving
   * them is what replayed a Session card's transcript into its own body on
   * every key-card change (2026-10-16). `null` in the shell, which builds
   * for every bound card that is not a body.
   */
  private _bodyCardId: string | null = null;

  /**
   * Subscribe to `cardSessionBindingStore` and reconcile once. Called
   * the first time anything reads from the store. Module-scope state
   * is created lazily so tests that don't construct any cards don't
   * pay for a wire connection or background subscriptions.
   */
  private _ensureInitialized(): void {
    if (this._initialized) return;
    this._initialized = true;
    this._bindingUnsub = cardSessionBindingStore.subscribe(() => {
      this._reconcile();
    });
    // A card that becomes a body, or comes back from one, changes which
    // bindings get services here.
    bodyCardsStore.subscribe(() => {
      this._reconcile();
    });
    this._reconcile();
  }

  /**
   * Wire the store in a body page: services are built for `cardId`'s binding
   * — the page's own card — from now on and for no other card's, ahead of
   * every later binding subscriber, as {@link attachDeckManager} orders them
   * in the shell. No deck is attached — closing the card is the shell's,
   * which holds its binding.
   */
  attachBody(cardId: string): void {
    this._bodyCardId = cardId;
    this._ensureInitialized();
    this._reconcile();
  }

  /**
   * Wire the store to a `DeckManager` so it can detect card teardown
   * and send `close_session` for any binding the destroyed card
   * holds. Called once from `main.tsx` after the deck-manager is
   * constructed. The wire is the card-lifecycle pipe's
   * `cardWillBeginDestruction` channel — the same pipe that owns the
   * card's existence, fired synchronously by every removal path
   * (`removeCard`, pane close) before the card leaves the store
   * (per [L24]: structure-zone stores observe layout changes that
   * affect their own state).
   *
   * Without this wire, the wire `close_session` frame would have to
   * be sent by the deck-canvas's user-close handler — but that
   * makes the deck know about a dev-specific store, violating [L10]
   * (one responsibility per layer). With this wire, the deck-canvas
   * stays card-type-agnostic.
   */
  attachDeckManager(deckManager: DeckManager): void {
    // Ensure the binding-store subscription is in place before any
    // later module subscribes to the same store. The downstream
    // `session-restore.ts` binding subscriber depends on
    // cardServicesStore having already constructed the per-card
    // services for a freshly-arrived binding (it looks up the
    // codeSessionStore via `getServices`); subscribers fire in
    // registration order, so cardServicesStore must register first.
    // Wiring this through `attachDeckManager` (the canonical
    // "wire me up at startup" entry point from `main.tsx`) makes the
    // ordering deterministic in production. Lazy init inside
    // `getServices` / `subscribe` still covers tests that don't call
    // `attachDeckManager`.
    this._ensureInitialized();
    this._deckManager = deckManager;

    if (this._deckUnsub) {
      this._deckUnsub();
      this._deckUnsub = null;
    }
    // If the destroyed card holds a binding, send `close_session` for
    // it; the binding clear triggers `_reconcile`'s dispose path.
    this._deckUnsub = deckManager.observeCardWillBeginDestruction(
      null,
      (cardId) => {
        logSessionLifecycle("services_store.deck_removed_card", {
          card_id: cardId,
        });
        this._closeCardInternal(cardId);
      },
    );
  }

  /**
   * Whether this page builds services for `cardId`'s binding: in a body, only
   * the page's own card; in the shell, every card that is not a body, whose
   * session lives in its body and is built there.
   */
  private _servesCard(cardId: string): boolean {
    if (this._bodyCardId !== null) return cardId === this._bodyCardId;
    return !bodyCardsStore.has(cardId);
  }

  /**
   * Diff `cardSessionBindingStore`'s current state against the
   * services map. Construct services for new bindings; dispose
   * services for vanished bindings. Notify React subscribers if
   * either map changed.
   *
   * A body card's binding gets no services: its session lives in its body,
   * which builds them there, and a body page builds for its own card alone
   * ({@link _servesCard}). The shell keeps the binding itself, so closing
   * the card still closes the session.
   */
  private _reconcile(): void {
    const bindings = cardSessionBindingStore.getSnapshot();
    let changed = false;

    // Construct for new bindings; rebuild when the same card flips to a
    // different session. The session-change branch is what makes a `/resume`
    // to another session and a `/clear` fresh-spawn swap in a fresh store —
    // without it, `_reconcile` keyed on cardId alone would keep the old
    // session's transcript on a rebind. Construction asks for no transcript;
    // the spawn ack that wrote the binding does, through `requestTranscript`.
    for (const [cardId, binding] of bindings) {
      if (!this._servesCard(cardId)) continue;
      const existing = this._services.get(cardId);
      const held = this._heldSwaps.get(cardId);
      if (held !== undefined) {
        if (held.services.tugSessionId === binding.tugSessionId) continue;
        // The binding moved on before the swap was ready — a second move, or
        // a `/clear` over a move still settling. The held bag was never
        // shown, so it goes quietly; the branches below take it from here.
        this._dropHeldSwap(cardId);
      }
      if (existing) {
        if (existing.tugSessionId === binding.tugSessionId) continue;
        // A directory change: build the new bag, keep the old one on screen
        // until the new session's transcript is ready.
        if (isDirectoryChangeRebind(cardId, binding.tugSessionId)) {
          this._beginHeldSwap(cardId, existing, binding);
          continue;
        }
        // Same card, new session → tear the old bag down before rebuilding.
        this._dispose(cardId);
      }
      const services = this._construct(cardId, binding);
      if (services) {
        this._services.set(cardId, services);
        changed = true;
      }
    }

    // Dispose for vanished bindings.
    for (const cardId of [...this._services.keys()]) {
      if (bindings.has(cardId) && this._servesCard(cardId)) continue;
      this._dropHeldSwap(cardId);
      this._dispose(cardId);
      changed = true;
    }

    if (changed) {
      this._listeners.notify();
    }
  }

  /**
   * Start a directory change's held swap: build the bag for the new session,
   * stop the shown one sending, and wait for the first of the new session's
   * replay completing, its store erroring, or {@link HELD_SWAP_LIMIT_MS}.
   *
   * The binding has already moved, so the title, the workspace key and every
   * reader of the binding follow the move at once; only what the bag renders
   * waits. The shown store's session is already closed — tugcast closed it
   * after acknowledging the move — and its `closed` state frame is dropped by
   * the store's own frame filter, so it stays quiet while it waits.
   */
  private _beginHeldSwap(
    cardId: string,
    shown: CardServices,
    binding: CardSessionBinding,
  ): void {
    const services = this._construct(cardId, binding);
    if (!services) {
      // No connection: nothing will ever answer for the new session, so
      // there is nothing to wait for. Swap now, as any other re-bind does.
      this._dispose(cardId);
      this._listeners.notify();
      return;
    }
    shown.codeSessionStore.holdSendsForHandOver();
    logSessionLifecycle("services_store.held_swap_begin", {
      card_id: cardId,
      tug_session_id: services.tugSessionId,
    });
    const store = services.codeSessionStore;
    const ready = (): boolean => {
      const snap = store.getSnapshot();
      return snap.replayEverCompleted || snap.phase === "errored";
    };
    let settled = false;
    // Deferred to a microtask: the swap disposes a store and seeds another,
    // and must not do either from inside the new store's own notification.
    // A microtask still lands before the frame is painted.
    const settle = (reason: "ready" | "timeout"): void => {
      if (settled) return;
      settled = true;
      queueMicrotask(() => void this._completeHeldSwap(cardId, services, reason));
    };
    const unsubscribe = store.subscribe(() => {
      if (ready()) settle("ready");
    });
    const timer = setTimeout(() => settle("timeout"), this._heldSwapLimitMs);
    this._heldSwaps.set(cardId, {
      services,
      release: () => {
        settled = true;
        unsubscribe();
        clearTimeout(timer);
      },
    });
    if (ready()) settle("ready");
  }

  /**
   * Show the new bag: dispose the old one, carry anything the user sent
   * while the swap waited into the new store, and notify once.
   *
   * The shown store is a mirror of an engine in the ingest Worker, so a send
   * the user made in the task before this one may not have come back yet;
   * the queued sends are read once the shown store has settled ([P09]). The
   * swap is re-checked after the wait, since it may have been dropped or
   * replaced while it waited.
   * The wait has the settle budget for its horizon ([L33]): a host that has
   * stopped answering leaves the swap to read the mirror as it stands, and
   * says so in the session lifecycle log.
   */
  private async _completeHeldSwap(
    cardId: string,
    services: CardServices,
    reason: "ready" | "timeout",
  ): Promise<void> {
    let held = this._heldSwaps.get(cardId);
    // Dropped or replaced since the swap settled: nothing to complete.
    if (held === undefined || held.services !== services) return;
    const shown = this._services.get(cardId);
    if (shown !== undefined && !shown.codeSessionStore.isSettled()) {
      const inTime = await shown.codeSessionStore.whenSettledWithin(SETTLE_WAIT_BUDGET_MS);
      if (!inTime) {
        logSessionLifecycle("services_store.settle_timeout", {
          card_id: cardId,
          at: "held_swap",
          budget_ms: SETTLE_WAIT_BUDGET_MS,
        });
      }
      held = this._heldSwaps.get(cardId);
      if (held === undefined || held.services !== services || this._services.get(cardId) !== shown) return;
    }
    held.release();
    this._heldSwaps.delete(cardId);
    const waiting = shown?.codeSessionStore.exportQueuedSends() ?? [];
    if (shown !== undefined) {
      this._disposeBag(cardId, shown, { stash: false });
    }
    this._services.set(cardId, services);
    logSessionLifecycle("services_store.held_swap_complete", {
      card_id: cardId,
      tug_session_id: services.tugSessionId,
      reason,
      handed_over: waiting.length,
    });
    services.codeSessionStore.seedQueuedSends(waiting);
    this._listeners.notify();
  }

  /** Discard a held swap's bag, which was never shown. */
  private _dropHeldSwap(cardId: string): void {
    const held = this._heldSwaps.get(cardId);
    if (held === undefined) return;
    held.release();
    this._heldSwaps.delete(cardId);
    this._disposeBag(cardId, held.services, { stash: false });
  }

  private _construct(cardId: string, binding: CardSessionBinding): CardServices | null {
    const connection = getConnection();
    if (!connection) {
      console.warn(
        "CardServicesStore: connection unavailable for cardId",
        cardId,
      );
      return null;
    }

    const lifecycle = getConnectionLifecycle();
    if (!lifecycle) {
      console.warn(
        "CardServicesStore: connection lifecycle unavailable for cardId",
        cardId,
      );
      return null;
    }

    // Faithful restore ([P06]): size the cold-resume window in turns to
    // include the saved scroll anchor. The transcript persists its anchor's
    // distance-from-bottom in **turns** (`turnDepthFromEnd`) into the card
    // bag; if the user was parked above the default window, load deep enough
    // (in turns) to reach the anchored turn (else the default N turns). The
    // anchor speaks the same unit the window does — a plain `max`, no row↔turn
    // bridging. Only for `resume` — a fresh spawn has nothing to restore (a
    // stale bag from a prior session is ignored).
    const restoreWindowTurns =
      binding.sessionMode === "resume"
        ? resolveRestoreWindow(
            readSavedAnchorTurnDepth(this._deckManager, cardId),
            DEFAULT_REPLAY_WINDOW_TURNS,
          )
        : DEFAULT_REPLAY_WINDOW_TURNS;

    // The staged shell / `/btw` context queue. Constructed before the code
    // session store so `send()` can consume it; also surfaced to the composer
    // (staged-count hint) and the shell / `/btw` rows (stage actions + badge).
    // Keyed by the **line** for durability across relaunch ([P07], [P12]), with
    // the card's session id as the legacy key a pre-lines blob carries from.
    const pendingContextStore = new PendingContextStore(
      binding.lineId,
      binding.tugSessionId,
    );

    const codeSessionStore = new CodeSessionStore({
      conn: connection,
      lifecycle,
      tugSessionId: binding.tugSessionId,
      pendingContextStore,
      // Thread the user's session-mode intent onto the store so
      // pure derivations (notably `deriveSessionCardBannerSpec`) can
      // suppress the JSONL-replay banner for new bindings without
      // a second subscription to `cardSessionBindingStore`. Stable
      // for the store's lifetime — a re-bind builds a fresh services
      // bag with a fresh store, so the mode field never goes stale.
      sessionMode: binding.sessionMode,
      // The window this resume requests (in turns), so the load bar reports
      // progress against the real target (the default N turns, or deeper for
      // a faithful restore) instead of a hard-coded default.
      restoreWindowTurns,
      // A session the harness bound by hand has nothing behind it on the
      // wire, so its writes stay off it (`harness-sessions.ts`).
      offWire: isHarnessSession(binding.tugSessionId),
    });
    const editorStore = new EditorSettingsStore();
    const transcriptStore = new TranscriptSettingsStore();

    // Filter by workspace_key for feeds that carry it. The workspace_key
    // is set on the binding when the supervisor acks and does not change
    // for the lifetime of this services bag — re-binds (close + reopen)
    // get a fresh services bag.
    const workspaceFilter: FeedStoreFilter = (_feedId, decoded) =>
      typeof decoded === "object" &&
      decoded !== null &&
      "workspace_key" in decoded &&
      (decoded as { workspace_key: unknown }).workspace_key === binding.workspaceKey;

    // SESSION_SIDEBAND is a single broadcast shared by every session
    // ([D06]/[D11]): tugcast splices `tug_session_id` into every frame and
    // relies on this client-side filter for isolation — same contract as
    // CODE_OUTPUT / SESSION_STATE in `CodeSessionStore`. Without it, any
    // session's `system_metadata` / `session_capabilities` rewrites every
    // card's model / mode / effort / catalog. workspace_key would be the
    // wrong key even if carried: two cards in one workspace must still be
    // isolated from each other.
    const sessionFilter: FeedStoreFilter = (_feedId, decoded) =>
      typeof decoded === "object" &&
      decoded !== null &&
      (decoded as { tug_session_id?: unknown }).tug_session_id ===
        binding.tugSessionId;

    const sessionMetadataFeedStore = new FeedStore(
      connection,
      [FeedId.SESSION_SIDEBAND],
      undefined,
      sessionFilter,
    );
    const sessionMetadataStore = new SessionMetadataStore(
      sessionMetadataFeedStore,
      FeedId.SESSION_SIDEBAND,
      binding.tugSessionId,
    );

    const fileTreeFeedStore = new FeedStore(
      connection,
      [FeedId.FILETREE],
      undefined,
      workspaceFilter,
    );
    // Pass the card's projectDir so FILETREE_QUERY frames carry `root`
    // and tugcast routes them to this card's workspace feed (with its
    // .tugattachignore + secret-file filter applied) rather than the
    // bootstrap (tugtool repo) feed. See
    // `arc/dev-atoms.md#step-pre-4`.
    const fileTreeStore = new FileTreeStore(
      fileTreeFeedStore,
      FeedId.FILETREE,
      binding.projectDir,
    );
    const fileCompletionProvider = fileTreeStore.getFileCompletionProvider();

    // No per-card GIT_DIFF feed: every diff surface sources its own store off
    // the shared unfiltered feed in `changeset-diff-store` (the Changes list's
    // per-entry stores, the Diff card's standalone one). A card-scoped store
    // here would be a second subscription waking on every GIT_DIFF broadcast
    // with nothing left to read it.

    // `/skills` ([#step-12d]): the single-shot request/response store, fed
    // by the session mirror's routed store for `skills_inventory`. The
    // response rides tugcode's stdout (relayed verbatim on CODE_OUTPUT), and
    // the ingest host routes this session's frames of that type to the
    // mirror ([P14]), so the page never reads the CODE_OUTPUT stream.
    const skillsInventoryStore = new SkillsInventoryStore(
      codeSessionStore.routedFrames("skills_inventory"),
      FeedId.CODE_OUTPUT,
      binding.tugSessionId,
    );

    // `/hooks` ([#step-12c]): same shape as `/skills`, fed by the routed
    // store for `hooks_inventory`.
    const hooksInventoryStore = new HooksInventoryStore(
      codeSessionStore.routedFrames("hooks_inventory"),
      FeedId.CODE_OUTPUT,
      binding.tugSessionId,
    );

    // `/btw` side questions (Spec S02): the ephemeral ask/answer history
    // store, fed by the routed store for `side_question_answer`. The frame is
    // deliberately absent from `KNOWN_CODE_OUTPUT_TYPES`, and the host routes
    // it past the engine, so it never reaches the transcript ([P05]).
    const sideQuestionStore = new SideQuestionStore(
      codeSessionStore.routedFrames("side_question_answer"),
      FeedId.CODE_OUTPUT,
      binding.tugSessionId,
      binding.lineId,
      pendingContextStore,
    );

    // `$`-route shell (Spec S01): a SHELL_OUTPUT feed narrowed to this
    // session's frames, plus the session store that folds them and mirrors
    // exchange rows into `codeSessionStore` ([P12]).
    const shellSessionFilter: FeedStoreFilter = (_feedId, decoded) =>
      typeof decoded === "object" &&
      decoded !== null &&
      (decoded as { tug_session_id?: unknown }).tug_session_id ===
        binding.tugSessionId;
    const shellSessionFeedStore = new FeedStore(
      connection,
      [FeedId.SHELL_OUTPUT],
      undefined,
      shellSessionFilter,
    );
    const shellSessionStore = new ShellSessionStore(
      shellSessionFeedStore,
      FeedId.SHELL_OUTPUT,
      binding.tugSessionId,
      binding.projectDir,
      codeSessionStore,
      pendingContextStore,
    );

    // `/match` and `/search`: a REFS_OUTPUT feed narrowed to this session's
    // frames, plus the store that folds them and mirrors each run into
    // `codeSessionStore` as a `refs` ink turn.
    const refsSessionFeedStore = new FeedStore(
      connection,
      [FeedId.REFS_OUTPUT],
      undefined,
      shellSessionFilter,
    );
    const refsSessionStore = new RefsSessionStore(
      refsSessionFeedStore,
      FeedId.REFS_OUTPUT,
      binding.tugSessionId,
      binding.projectDir,
      codeSessionStore,
    );

    // What the shell-line classifier tests membership against ([P08]): the
    // login-PATH set unioned with this session shell's own words. Shares the
    // shell session's SHELL_OUTPUT feed; request it now (at bind) so the set is
    // warm before the first submit. The project dir rides along because the
    // word dump's shell stands there, and rc files branch on where they are.
    const pathCommandsStore = new PathCommandsStore(
      shellSessionFeedStore,
      FeedId.SHELL_OUTPUT,
      binding.tugSessionId,
      binding.projectDir,
    );
    pathCommandsStore.request();

    // Command-grammar grading for the same classifier. Shares the shell
    // session's SHELL_OUTPUT feed; nothing to request at bind, since a grade is
    // about one typed line.
    const shellGrammarStore = new ShellGrammarStore(
      shellSessionFeedStore,
      FeedId.SHELL_OUTPUT,
      binding.tugSessionId,
    );
    // Its partner: the grammar grades a line, and this asks the SharedAgent
    // about the ones grading could not settle. Same feed, same session filter,
    // same acquire-here/release-in-dispose contract [L27].
    const shellClassifyStore = new ShellClassifyStore(
      shellSessionFeedStore,
      FeedId.SHELL_OUTPUT,
      binding.tugSessionId,
    );

    // `±`-route Changes controller ([P07]): a filtered projection over the
    // app-level `ChangesetAllStore` singleton — NO new FeedStore (the
    // per-workspace CHANGESET feed 0x23 is retired). Scoped to this card's
    // workspace + session; disposed below (unsubscribes from the singleton).
    const changesController = new ChangesRouteController({
      tugSessionId: binding.tugSessionId,
      workspaceKey: binding.workspaceKey,
      projectDir: binding.projectDir,
    });

    // Bind success → prepend this card's project path to the dev
    // recent-projects list (dedup, cap). Done here rather than in a
    // React effect so the side effect is co-located with services
    // construction; running it on every dep change of a React effect
    // would multiply-write the same path.
    //
    // A path that falls off the capped list leaves the list and nothing
    // else. Its sessions and transcripts are untouched: the cap bounds a
    // convenience menu, and is never the user saying they are done with a
    // project [L23]. Only the user's own Trash gesture removes a session.
    //
    // The path is persisted, so it goes through the canonicalization gateway
    // first ([L29]) — `recordSessionRecentProject` stores the server's
    // spelling and folds any other spelling of the same directory into it.
    const tugbank = getTugbankClient();
    if (tugbank) void recordSessionRecentProject(tugbank, binding.projectDir);

    logSessionLifecycle("services_store.construct", {
      card_id: cardId,
      tug_session_id: binding.tugSessionId,
    });

    // No transcript is asked for here. Building a card's stores and reading
    // its transcript are two acts, and the second has a reason the builder
    // does not know: `requestTranscript` is called with it by the spawn ack
    // that wrote this binding. A path that builds stores for any other cause
    // gets stores and no `request_replay`.
    //
    // Cold-boot preflight beat: only resume-mode bindings face a
    // 5–10s tugcode-boot wait, so only they open the preflight
    // banner. New-mode bindings have nothing to restore from a prior
    // session and do not flash the banner.
    if (binding.sessionMode === "resume") {
      codeSessionStore.notifyResumeBindingLanded();
    }
    // Hand back anything the previous store for this card was holding
    // when it was disposed. Seeded at construction, before the transcript
    // is requested, so the queue is already in place when the replay
    // terminates — that terminal is where it drains.
    const stranded = drainQueuedSends(cardId);
    if (stranded !== undefined) {
      codeSessionStore.seedQueuedSends(stranded);
    }
    // A card opened by Run in New Session carries the command it was opened
    // to run, and runs it itself: the runner sends it straight from this bag
    // once the replay is done, the session can submit, and the catalog has
    // named the qualified command. The composer is not on the road — a card
    // still being born mounts, restores and remounts it, and the command used
    // to be lost in each. See `opening-command-runner.ts`.
    const opening = drainOpeningCommand(cardId);
    if (opening !== undefined) {
      this._openingRuns.set(
        codeSessionStore,
        runOpeningCommand(cardId, opening, codeSessionStore, sessionMetadataStore),
      );
    }
    const services: CardServices = {
      tugSessionId: binding.tugSessionId,
      codeSessionStore,
      editorStore,
      transcriptStore,
      sessionMetadataStore,
      sessionMetadataFeedStore,
      fileTreeStore,
      fileTreeFeedStore,
      skillsInventoryStore,
      hooksInventoryStore,
      sideQuestionStore,
      shellSessionStore,
      shellSessionFeedStore,
      refsSessionStore,
      refsSessionFeedStore,
      pathCommandsStore,
      shellGrammarStore,
      shellClassifyStore,
      changesController,
      pendingContextStore,
      fileCompletionProvider,
    };
    this._restoreWindows.set(services, restoreWindowTurns);
    return services;
  }

  /**
   * Ask for `cardId`'s transcript, for `reason` — the one way a Session
   * card's transcript is read from disk.
   *
   * Called by the `spawn_session_ok` that bound the card, with the reason the
   * spawn was sent for. Reaches the bag built for the binding's session: the
   * shown one, or a directory change's held bag. A bag is read at most once;
   * a second request for it is declined and logged, because the store already
   * holds what the replay would send. A card this page has no bag for — a
   * body's card in the shell, a binding with no connection — is logged and
   * left alone.
   *
   * The request bounds the load by recency: only the most recent N committed
   * turns (the canonical unit), or deeper to reach a saved anchor. tugcode
   * reports the loaded slice on `replay_complete`, and older turns page in on
   * demand.
   */
  requestTranscript = (cardId: string, reason: ReloadReason): boolean => {
    this._ensureInitialized();
    const binding = cardSessionBindingStore.getBinding(cardId);
    const held = this._heldSwaps.get(cardId)?.services;
    const shown = this._services.get(cardId);
    const services =
      binding === undefined
        ? undefined
        : held?.tugSessionId === binding.tugSessionId
          ? held
          : shown?.tugSessionId === binding.tugSessionId
            ? shown
            : undefined;
    const connection = getConnection();
    if (services === undefined || connection === null) {
      logSessionLifecycle("request_replay.no_services", {
        card_id: cardId,
        tug_session_id: binding?.tugSessionId ?? null,
        reason,
      });
      return false;
    }
    if (this._transcriptRequested.has(services)) {
      logSessionLifecycle("request_replay.declined", {
        card_id: cardId,
        tug_session_id: services.tugSessionId,
        reason,
      });
      return false;
    }
    this._transcriptRequested.set(services, reason);
    const window = {
      lastTurns: this._restoreWindows.get(services) ?? DEFAULT_REPLAY_WINDOW_TURNS,
    };
    services.codeSessionStore.noteReplayAsked(window);
    sendRequestReplay(connection, services.tugSessionId, reason, window);
    return true;
  };

  private _dispose(cardId: string): void {
    const services = this._services.get(cardId);
    if (!services) return;
    this._services.delete(cardId);
    this._disposeBag(cardId, services, { stash: true });
  }

  /**
   * Tear one bag down. `stash` rescues its queued sends for the next bag
   * this card is given; a held swap hands them over directly instead.
   */
  private _disposeBag(
    cardId: string,
    services: CardServices,
    opts: { stash: boolean },
  ): void {
    logSessionLifecycle("services_store.dispose", { card_id: cardId });
    this._openingRuns.get(services.codeSessionStore)?.();
    this._openingRuns.delete(services.codeSessionStore);
    const store = services.codeSessionStore;
    const settled = store.isSettled();
    if (opts.stash) {
      // Rescue anything the user queued before the store goes down with
      // the bag. A reconnect disposes every card up front, before any
      // restore is attempted, so this is the last moment those messages
      // exist anywhere ([L23]).
      //
      // A send posted in the task before this one may not have come back
      // from the ingest Worker yet ([P09]). Then the store outlives its bag
      // by that one acknowledgment: it is stashed and disposed once it has
      // settled, or once the settle budget has passed, logged, with the
      // mirror as it stands ([L33]). The restore that drains the stash
      // answers a request sent after this, through the same Worker, which
      // handled the send — and flushed its acknowledgment — before it could
      // read that reply, so the stash is always in place first.
      if (settled) {
        stashQueuedSends(cardId, store.exportQueuedSends());
      } else {
        void store.whenSettledWithin(SETTLE_WAIT_BUDGET_MS).then((inTime) => {
          if (!inTime) {
            logSessionLifecycle("services_store.settle_timeout", {
              card_id: cardId,
              at: "stash",
              budget_ms: SETTLE_WAIT_BUDGET_MS,
            });
          }
          stashQueuedSends(cardId, store.exportQueuedSends());
          store.dispose();
        });
      }
    }
    if (!opts.stash || settled) store.dispose();
    services.transcriptStore.dispose();
    services.sessionMetadataStore.dispose();
    services.sessionMetadataFeedStore.dispose();
    services.fileTreeStore.dispose();
    services.fileTreeFeedStore.dispose();
    services.skillsInventoryStore.dispose();
    services.hooksInventoryStore.dispose();
    services.sideQuestionStore.dispose();
    services.shellSessionStore.dispose();
    services.pathCommandsStore.dispose();
    services.shellGrammarStore.dispose();
    services.shellClassifyStore.dispose();
    services.shellSessionFeedStore.dispose();
    services.refsSessionStore.dispose();
    services.refsSessionFeedStore.dispose();
    services.changesController.dispose();
    services.pendingContextStore.dispose();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Subscribe to "any cardId's services entry changed" notifications.
   * Used by `useSyncExternalStore` in `useSessionCardServices`.
   */
  subscribe = (listener: () => void): (() => void) => {
    this._ensureInitialized();
    return this._listeners.subscribe(listener);
  };

  /**
   * Read services for `cardId`, or `null` if no binding exists yet.
   * Called by `useSyncExternalStore`'s snapshot getter — must be
   * synchronous and reference-stable for unchanged values (the same
   * reference is returned across reads until `_reconcile` mutates the
   * map).
   */
  getServices = (cardId: string): CardServices | null => {
    this._ensureInitialized();
    return this._services.get(cardId) ?? null;
  };

  /**
   * The reason `cardId`'s shown bag was read for, or undefined when it has
   * not been read. A same-server reconnect re-reads a bag whose read the
   * drop cut short, for this reason ([B03]).
   */
  transcriptReason = (cardId: string): ReloadReason | undefined => {
    const services = this._services.get(cardId);
    return services === undefined ? undefined : this._transcriptRequested.get(services);
  };

  /**
   * Find a card's services by its bound `tug_session_id` — used to route a
   * session-scoped CONTROL response (e.g. `list_shell_exchanges_ok`) back to
   * the owning card's stores. Returns null if no live card holds that session.
   */
  /**
   * Every live card's services bag, in insertion order. Used by the
   * deck's termination pipeline, which has to reach every session that
   * might be mid-turn — it has no card id to look one up by, and asking
   * for "all of them" is exactly what it means.
   */
  allServices = (): CardServices[] => {
    this._ensureInitialized();
    return Array.from(this._services.values());
  };

  /**
   * Run `fn` against every live card's session store.
   *
   * Narrower than {@link allServices} on purpose. A caller that wants to
   * act on the stores' lifecycle — hold their notifications for the
   * length of a gesture, say — has no business holding the services
   * bags, which carry the connection, the shell session, and the
   * composer's staged attachments. Handing out the one thing asked for
   * keeps that caller from growing a reach it never needed.
   */
  forEachCodeSessionStore = (fn: (store: CodeSessionStore, cardId: string) => void): void => {
    this._ensureInitialized();
    for (const [cardId, services] of this._services) {
      fn(services.codeSessionStore, cardId);
    }
  };

  getByTugSessionId = (tugSessionId: string): CardServices | null => {
    this._ensureInitialized();
    for (const services of this._services.values()) {
      if (services.tugSessionId === tugSessionId) return services;
    }
    // A bag a directory change has built and not yet shown is still the
    // owner of its session's answers — the shell and refs restores it asked
    // for at construction land while it waits.
    for (const held of this._heldSwaps.values()) {
      if (held.services.tugSessionId === tugSessionId) return held.services;
    }
    return null;
  };

  /**
   * Send `close_session` for the card's binding (if any), which
   * clears the binding and triggers `_reconcile` to dispose services.
   * Internal to the store — fired automatically when the deck-manager
   * removes a card (see `attachDeckManager`). The resume-failed
   * unbind path bypasses this: it clears the binding directly so no
   * close frame is sent to a supervisor session that has already
   * torn down.
   */
  private _closeCardInternal(cardId: string): void {
    // The user is closing the card, not losing it. Anything still
    // queued goes with it — the stash exists to survive an accident,
    // and a message must never resurface later on an unrelated
    // session bound to a recycled card id.
    clearQueuedSends(cardId);
    // And a command the card was opened to run, which has even less business
    // reaching a later session on a recycled card id.
    clearOpeningCommand(cardId);
    // Nothing to restore for a card that is going away ([L27]).
    cancelRestoreRetry(cardId);
    forgetPendingReload(cardId);
    const binding = cardSessionBindingStore.getBinding(cardId);
    if (!binding) return;
    const conn = getConnection();
    if (!conn) {
      // No connection means no wire frame to send. Clear locally so
      // the services bag is disposed and the card unbinds cleanly.
      cardSessionBindingStore.clearBinding(cardId);
      return;
    }
    sendCloseSession(conn, cardId, binding.tugSessionId);
  }

  /**
   * Send `close_session` for a card that holds NO binding, using a session id
   * the caller supplies ([P07]).
   *
   * {@link _closeCardInternal} reads the binding to learn which session to
   * close, and returns early when there is none. That is right for the path it
   * serves — a card being removed from the rendered deck either holds a
   * binding or has no session — and wrong for a workspace that is being
   * deleted without ever having been activated. Such a workspace's session
   * cards were never restored, so by [B04]'s own design they hold no bindings,
   * while the bindings-ledger cache ([P08]) knows perfectly well that their
   * sessions are alive. Deleting it through destruction alone would leave
   * every one of those tugcode processes orphaned, with no card left that
   * could ever reach them — and the confirm the user just answered counted
   * them from that same cache, so the dialog would say "close 3 sessions" and
   * close none.
   *
   * So the caller passes the id it counted with. `DeckManager.deleteSpace` is
   * the one caller, and it calls this only for cards with no binding — cards
   * that DO hold one keep closing through the destruction event, so the two
   * paths are disjoint by construction and no card is closed twice.
   */
  closeUnboundCard = (cardId: string, tugSessionId: string): void => {
    // The same housekeeping `_closeCardInternal` does, and for the same
    // reasons: nothing queued, nothing opening, nothing retrying may outlive
    // the card and resurface on a later session bound to a recycled id.
    clearQueuedSends(cardId);
    clearOpeningCommand(cardId);
    cancelRestoreRetry(cardId);
    forgetPendingReload(cardId);
    const conn = getConnection();
    // No connection means no wire frame to send, and no binding to clear
    // either — this card never had one.
    if (!conn) return;
    sendCloseSession(conn, cardId, tugSessionId);
  };

  /**
   * Test seam — exposes `_closeCardInternal` so unit tests can
   * directly assert the close behavior without spinning up a
   * real `DeckManager`. NOT for production use; the deck-manager's
   * destruction observer is the only path that should fire close in
   * production.
   * @internal
   */
  closeCardForTest(cardId: string): void {
    this._closeCardInternal(cardId);
  }

  /**
   * Test seam — shorten (or, with `null`, restore) the longest a directory
   * change holds the old transcript, so the limit's exit runs in a test.
   * @internal
   */
  setHeldSwapLimitForTest(ms: number | null): void {
    this._heldSwapLimitMs = ms ?? HELD_SWAP_LIMIT_MS;
  }

  /**
   * Test seam — forget the body card {@link attachBody} recorded, so a suite
   * that modelled a body page hands the singleton back as a shell. Bun runs
   * every file in one process, and a store left as a body would refuse the
   * next file's cards.
   * @internal
   */
  detachBodyForTest(): void {
    this._bodyCardId = null;
    this._reconcile();
  }
}

export const cardServicesStore = new CardServicesStore();
