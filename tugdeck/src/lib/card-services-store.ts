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

import { CodeSessionStore } from "./code-session-store";
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
import { encodeTrashProjectDirSessions } from "../protocol";
import { DEFAULT_REPLAY_WINDOW_TURNS } from "../protocol";
import { resolveRestoreWindow } from "./session-restore-window";
// Cycle note: `session-restore` imports this module's singleton. These
// three are called only from methods below, never during module
// initialization, so the cycle resolves cleanly in both orders.
import {
  cancelRestoreRetry,
  clearQueuedSends,
  drainQueuedSends,
  stashQueuedSends,
} from "./session-restore";
import { getConnectionLifecycle } from "./connection-lifecycle";
import { getTugbankClient } from "./tugbank-singleton";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "./card-session-binding-store";
import { sendCloseSession, sendRequestReplay } from "./session-lifecycle";
import {
  readSessionRecentProjects,
  insertSessionRecentProject,
  putSessionRecentProjects,
} from "../settings-api";
import type { DeckManager } from "../deck-manager";
import { logSessionLifecycle } from "./session-lifecycle-log";

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
   * Single-shot `/skills` request/response store ([#step-12d]) and its
   * CODE_OUTPUT feed (filtered to `type === "skills_inventory"` for this
   * session). Fires `skills_inventory_query` and resolves the matching
   * tugcode response — not a continuous subscription.
   */
  readonly skillsInventoryStore: SkillsInventoryStore;
  readonly skillsInventoryFeedStore: FeedStore;
  /**
   * Single-shot `/hooks` request/response store ([#step-12c]) and its
   * CODE_OUTPUT feed (filtered to `type === "hooks_inventory"`).
   */
  readonly hooksInventoryStore: HooksInventoryStore;
  readonly hooksInventoryFeedStore: FeedStore;
  /**
   * `/btw` side-question store (Spec S02) and its CODE_OUTPUT feed (filtered
   * to `type === "side_question_answer"` for this session). Keeps an ephemeral
   * ask/answer history; overlay-only, never dispatched to the code-session
   * store ([P05]). NOT a `KNOWN_CODE_OUTPUT_TYPES` member, so the transcript
   * never sees a side question.
   */
  readonly sideQuestionStore: SideQuestionStore;
  readonly sideQuestionFeedStore: FeedStore;
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
  private readonly _listeners = new Set<() => void>();
  private _bindingUnsub: (() => void) | null = null;
  private _deckUnsub: (() => void) | null = null;
  /** The attached deck, read at construct time for the saved scroll anchor
   *  (faithful restore window sizing, #step-6). */
  private _deckManager: DeckManager | null = null;
  private _initialized = false;

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
   * Diff `cardSessionBindingStore`'s current state against the
   * services map. Construct services for new bindings; dispose
   * services for vanished bindings. Notify React subscribers if
   * either map changed.
   */
  private _reconcile(): void {
    const bindings = cardSessionBindingStore.getSnapshot();
    let changed = false;

    // Construct for new bindings; rebuild when the same card flips to a
    // different session. The session-change branch is what makes a `/resume`
    // to another session and a `/clear` fresh-spawn swap in a fresh store
    // (and a fresh `request_replay`) — without it, `_reconcile` keyed on
    // cardId alone would keep the old session's transcript on a rebind.
    for (const [cardId, binding] of bindings) {
      const existing = this._services.get(cardId);
      if (existing) {
        if (existing.tugSessionId === binding.tugSessionId) continue;
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
      if (bindings.has(cardId)) continue;
      this._dispose(cardId);
      changed = true;
    }

    if (changed) {
      for (const l of this._listeners) l();
    }
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
    // Keyed by tug_session_id for durability across relaunch ([P07]).
    const pendingContextStore = new PendingContextStore(binding.tugSessionId);

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
    // `dash/dev-atoms.md#step-pre-4`.
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

    // `/skills` ([#step-12d]): a CODE_OUTPUT feed narrowed to this session's
    // `skills_inventory` frames (so the high-traffic stream only wakes the
    // store on its own response), plus the single-shot request/response store.
    // The response rides tugcode's stdout (relayed verbatim on CODE_OUTPUT),
    // so there is no dedicated feed id — the filter does the narrowing.
    const skillsInventoryFilter: FeedStoreFilter = (_feedId, decoded) =>
      typeof decoded === "object" &&
      decoded !== null &&
      (decoded as { type?: unknown }).type === "skills_inventory" &&
      (decoded as { tug_session_id?: unknown }).tug_session_id ===
        binding.tugSessionId;
    const skillsInventoryFeedStore = new FeedStore(
      connection,
      [FeedId.CODE_OUTPUT],
      undefined,
      skillsInventoryFilter,
    );
    const skillsInventoryStore = new SkillsInventoryStore(
      skillsInventoryFeedStore,
      FeedId.CODE_OUTPUT,
      binding.tugSessionId,
    );

    // `/hooks` ([#step-12c]): same shape as `/skills` — a CODE_OUTPUT feed
    // narrowed to this session's `hooks_inventory` frames, plus the single-shot
    // request/response store.
    const hooksInventoryFilter: FeedStoreFilter = (_feedId, decoded) =>
      typeof decoded === "object" &&
      decoded !== null &&
      (decoded as { type?: unknown }).type === "hooks_inventory" &&
      (decoded as { tug_session_id?: unknown }).tug_session_id ===
        binding.tugSessionId;
    const hooksInventoryFeedStore = new FeedStore(
      connection,
      [FeedId.CODE_OUTPUT],
      undefined,
      hooksInventoryFilter,
    );
    const hooksInventoryStore = new HooksInventoryStore(
      hooksInventoryFeedStore,
      FeedId.CODE_OUTPUT,
      binding.tugSessionId,
    );

    // `/btw` side questions (Spec S02): a CODE_OUTPUT feed narrowed to this
    // session's `side_question_answer` frames, plus the ephemeral ask/answer
    // history store. The frame is deliberately absent from
    // `KNOWN_CODE_OUTPUT_TYPES`, so it reaches ONLY this dedicated feed and
    // never the code-session (transcript) store ([P05]).
    const sideQuestionFilter: FeedStoreFilter = (_feedId, decoded) =>
      typeof decoded === "object" &&
      decoded !== null &&
      (decoded as { type?: unknown }).type === "side_question_answer" &&
      (decoded as { tug_session_id?: unknown }).tug_session_id ===
        binding.tugSessionId;
    const sideQuestionFeedStore = new FeedStore(
      connection,
      [FeedId.CODE_OUTPUT],
      undefined,
      sideQuestionFilter,
    );
    const sideQuestionStore = new SideQuestionStore(
      sideQuestionFeedStore,
      FeedId.CODE_OUTPUT,
      binding.tugSessionId,
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
    const tugbank = getTugbankClient();
    if (tugbank) {
      const current = readSessionRecentProjects(tugbank);
      const updated = insertSessionRecentProject(current, binding.projectDir);
      if (updated[0] !== current[0] || updated.length !== current.length) {
        putSessionRecentProjects(updated);
        // Recents↔ledger coherence: any path that fell off the recents
        // tail also has its ledger rows dropped so the picker doesn't
        // surface sessions for a path the user no longer recognizes.
        // Computed as the set difference (current \ updated) — a path is
        // evicted when it was in `current` but not in `updated`.
        const updatedSet = new Set(updated);
        const evicted = current.filter((p) => !updatedSet.has(p));
        if (evicted.length > 0) {
          trashLedgerForEvictedRecents(evicted);
        }
      }
    }

    logSessionLifecycle("services_store.construct", {
      card_id: cardId,
      tug_session_id: binding.tugSessionId,
    });

    // Recovery dispatch ([D12], Phase A-R1 / Step R1c, broadened by
    // mid-turn-replay [Step 5](dash/tugplan-session-mid-turn-replay.md#step-5)).
    // Whenever fresh services are constructed for a binding, ask the
    // supervisor to forward a `request_replay` verb to the live tugcode
    // subprocess. The verb tells tugcode to re-run `runReplay` so the
    // freshly-mounted `CodeSessionStore` rehydrates its transcript.
    //
    // Idempotent at three layers per [D04] msg_id dedupe + tugcode's
    // re-entrancy guard + supervisor's Live-only forward. For a fresh
    // new-spawn binding whose JSONL doesn't exist yet, the translator
    // emits `replay_started → replay_complete{kind: "jsonl_missing"}`
    // and the reducer flashes through `replaying` back to `idle` —
    // harmless. For ANY binding whose session has had wire activity
    // (the post-Step-5 smoke test scenario: open new card, type
    // "hello", get response, `Maker > Reload`), the JSONL has
    // content and the replay rehydrates the transcript.
    //
    // The previous gate (`if (binding.sessionMode === "resume")`)
    // assumed "mode=new ⇒ no content to replay." That holds at the
    // moment of spawn but rots the moment a turn lands. After the
    // first turn, the JSONL has content, and any rebind of the same
    // session needs a replay regardless of the original spawn mode.
    // Dropping the gate makes the front end ask for replay
    // unconditionally and lets the backend decide what to send.
    //
    // The dispatch runs AFTER `codeSessionStore` is constructed, so the
    // store is already subscribed to CODE_OUTPUT before the supervisor
    // starts streaming reply frames — no race between subscription and
    // first inbound `replay_started`.
    //
    // Cold-boot preflight beat: only resume-mode bindings face a
    // 5–10s tugcode-boot wait, so only they open the preflight
    // banner. New-mode bindings have nothing to restore from a prior
    // session and do not flash the banner; the request_replay still
    // fires (and lands on an empty JSONL) for the post-content rebind
    // case described above.
    if (binding.sessionMode === "resume") {
      codeSessionStore.notifyResumeBindingLanded();
    }
    // Hand back anything the previous store for this card was holding
    // when it was disposed. Seeded before `request_replay` so the queue
    // is already in place when the replay terminates — that terminal is
    // where it drains.
    const stranded = drainQueuedSends(cardId);
    if (stranded !== undefined) {
      codeSessionStore.seedQueuedSends(stranded);
    }
    // Bound the cold-resume load by recency: replay only the most recent N
    // committed turns (the canonical unit). A long session loads its relevant
    // tail fast; older turns page in on demand. tugcode reports the loaded
    // slice (oldest turn/message index, totals, hasOlder) on
    // `replay_complete`.
    sendRequestReplay(connection, binding.tugSessionId, {
      lastTurns: restoreWindowTurns,
    });

    return {
      tugSessionId: binding.tugSessionId,
      codeSessionStore,
      editorStore,
      transcriptStore,
      sessionMetadataStore,
      sessionMetadataFeedStore,
      fileTreeStore,
      fileTreeFeedStore,
      skillsInventoryStore,
      skillsInventoryFeedStore,
      hooksInventoryStore,
      hooksInventoryFeedStore,
      sideQuestionStore,
      sideQuestionFeedStore,
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
  }

  private _dispose(cardId: string): void {
    const services = this._services.get(cardId);
    if (!services) return;
    logSessionLifecycle("services_store.dispose", { card_id: cardId });
    this._services.delete(cardId);
    // Rescue anything the user queued before the store goes down with
    // the bag. A reconnect disposes every card up front, before any
    // restore is attempted, so this is the last moment those messages
    // exist anywhere ([L23]).
    stashQueuedSends(cardId, services.codeSessionStore.exportQueuedSends());
    services.codeSessionStore.dispose();
    services.transcriptStore.dispose();
    services.sessionMetadataStore.dispose();
    services.sessionMetadataFeedStore.dispose();
    services.fileTreeStore.dispose();
    services.fileTreeFeedStore.dispose();
    services.skillsInventoryStore.dispose();
    services.skillsInventoryFeedStore.dispose();
    services.hooksInventoryStore.dispose();
    services.hooksInventoryFeedStore.dispose();
    services.sideQuestionStore.dispose();
    services.sideQuestionFeedStore.dispose();
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
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
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
  forEachCodeSessionStore = (fn: (store: CodeSessionStore) => void): void => {
    this._ensureInitialized();
    for (const services of this._services.values()) {
      fn(services.codeSessionStore);
    }
  };

  getByTugSessionId = (tugSessionId: string): CardServices | null => {
    this._ensureInitialized();
    for (const services of this._services.values()) {
      if (services.tugSessionId === tugSessionId) return services;
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
    // Nothing to restore for a card that is going away ([L27]).
    cancelRestoreRetry(cardId);
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
}

export const cardServicesStore = new CardServicesStore();

/**
 * Send `trash_project_dir_sessions` for each path that fell off the
 * recents tail. The supervisor matches by `project_dir` (literal user
 * path) and broadcasts a `session_updated { removed: true }` for each
 * dropped row. The store cache then patches itself.
 *
 * Fire-and-forget: there's no UX surface for the result of this batch
 * action (the user is just spawning a fresh card; the recents-cap
 * eviction is invisible). Errors are warnings, not blockers.
 */
function trashLedgerForEvictedRecents(paths: ReadonlyArray<string>): void {
  const connection = getConnection();
  if (!connection) return;
  for (const path of paths) {
    const frame = encodeTrashProjectDirSessions(path);
    try {
      connection.send(frame.feedId, frame.payload);
    } catch (err) {
      console.warn(
        `[recents-eviction] trash_project_dir_sessions for ${path} failed:`,
        err,
      );
    }
  }
}
