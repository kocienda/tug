/**
 * The deck's teardown saves: the one core every teardown-class path runs
 * through, and the quit pipeline built on it.
 *
 * The `DeckManager` keeps the entry points — `captureAllForTeardown`,
 * `saveAndFlushSync`, `saveAndFlush`, `prepareForReload`, the
 * visibilitychange handler, `prepareForTermination` — because each adds a
 * guard over the manager's own `reloadPending` / `stateFlushed` flags. What
 * they share lives here, once, reaching the layout save, the save callbacks
 * and the card-state flush through {@link TeardownSaveDeps}. [L23]
 */

import type { CardFlushResult } from "./card-state-cache";
import type { SaveCallbackSource } from "./deck-trace";
import { flushPromptHistorySync } from "./lib/prompt-history-api";
import { cardServicesStore } from "./lib/card-services-store";
import type { CodeSessionStore } from "./lib/code-session-store";

/** What one run of the teardown-save core actually persisted. */
export interface TeardownSaveResult {
  layoutSaved: boolean;
  cards: CardFlushResult[];
}

/**
 * What the deck actually managed to do before the host tore the process
 * down — the resolved value of `DeckManager.prepareForTermination`,
 * returned across the bridge and logged verbatim by the host.
 *
 * `ok: false` never blocks or delays the quit; it makes the failure named
 * instead of silent, which is the whole point of the pipeline.
 */
export interface TerminationVerdict {
  /** True when every phase below came back clean. */
  ok: boolean;
  /** `tug_session_id`s interrupted and observed to settle. */
  interrupted: string[];
  /** Interrupt sent, but the session had not settled when the bound expired. */
  unacknowledged: string[];
  /** Card bags written and confirmed by tugbank. */
  flushedCards: number;
  /** Card ids whose writes still failed after the retry budget. */
  failedCards: string[];
  layoutSaved: boolean;
  elapsedMs: number;
}

/**
 * How long the termination pipeline waits for interrupted sessions to
 * settle. Sized to contain tugcode's own ladder — a 2 s in-band ack grace
 * plus a 1.5 s SIGINT grace — with margin. A session that has not settled
 * by then is reported unacknowledged and the quit proceeds ([P04]: a quit
 * may be slow, never hung).
 */
const TERMINATION_INTERRUPT_AWAIT_MS = 5000;

/**
 * Total time the pipeline will spend re-attempting card-state writes that
 * tugbank rejected, and the gap between attempts. Covers the supervisor's
 * first restart-backoff steps, which is the realistic reason a write fails
 * at quit time.
 */
const TERMINATION_FLUSH_RETRY_BUDGET_MS = 5000;
const TERMINATION_FLUSH_RETRY_INTERVAL_MS = 250;

type FlushOptions = { keepalive?: boolean; sync?: boolean; force?: boolean };

export interface TeardownSaveOptions {
  layoutSave?: "if-pending" | "always";
  sync?: boolean;
  force?: boolean;
}

/** What the teardown-save core reaches on the manager. */
export interface TeardownSaveDeps {
  /** Retire the debounced layout save; say whether one was pending. */
  takePendingLayoutSave(): boolean;
  saveLayout(): Promise<boolean>;
  /** The ids with a registered save callback, snapshotted. */
  saveCallbackIds(): string[];
  invokeSaveCallback(cardId: string, source: SaveCallbackSource): void;
  flushDirtyCardStates(options?: FlushOptions): Promise<CardFlushResult[]>;
}

/**
 * The teardown-save core every teardown-class path runs through.
 *
 * Always, in this order: retire the pending debounced layout save
 * (writing it when one was in flight, or unconditionally when the
 * caller asks), invoke every registered save callback tagged with
 * `source`, then flush the dirty card-state bags. The wrappers add
 * only their own guard semantics — the *guarantee* lives here, once,
 * so no entry point can hold a partial version of it. `saveAndFlushSync`
 * used to skip the layout half entirely, which dropped any layout
 * change still inside its debounce window on ⌘Q.
 *
 * `layoutSave: "always"` is for callers that own a whole termination
 * (reload, quit): the extra write costs nothing on a once-per-exit path
 * and makes the reported `layoutSaved` mean "the current layout is on
 * disk". The default `"if-pending"` keeps the frequent teardown signals
 * (HMR, visibilitychange) from writing a layout that never changed.
 *
 * Everything imperative happens synchronously before the first await, so
 * a `sync` caller on the unload path still gets its XHR writes issued
 * inline. [L23]; [L10] — per-card capture is dispatched through
 * `invokeSaveCallback`, never by reaching into card internals.
 */
export function teardownSave(
  deps: TeardownSaveDeps,
  source: SaveCallbackSource,
  options?: TeardownSaveOptions,
): Promise<TeardownSaveResult> {
  const layoutPending = deps.takePendingLayoutSave();
  const layoutPromise =
    layoutPending || options?.layoutSave === "always"
      ? deps.saveLayout()
      : Promise.resolve(true);

  // Snapshot the keys first so a callback that unregisters another
  // card mid-iteration does not confuse the Map iterator.
  for (const cardId of deps.saveCallbackIds()) {
    deps.invokeSaveCallback(cardId, source);
  }

  // Drain any prompt append still in the outbox. A `sync` teardown is the
  // page going away, where a queued fetch would never settle — and a prompt
  // the user submitted has to reach the ledger before the process does. Runs
  // after the card callbacks so a submit folded in by `"termination"` is
  // already queued. [L23]
  if (options?.sync === true) {
    flushPromptHistorySync();
  }

  const cardsPromise = deps.flushDirtyCardStates({
    sync: options?.sync,
    force: options?.force,
  });

  return Promise.all([layoutPromise, cardsPromise]).then(([layoutSaved, cards]) => ({
    layoutSaved,
    cards,
  }));
}

/** What the termination pipeline reaches on the manager. */
export interface TerminationDeps {
  teardownSave(source: SaveCallbackSource, options?: TeardownSaveOptions): Promise<TeardownSaveResult>;
  saveLayout(): Promise<boolean>;
  flushDirtyCardStates(options?: FlushOptions): Promise<CardFlushResult[]>;
  interruptLiveSessions(): Promise<{ interrupted: string[]; unacknowledged: string[] }>;
  /** Lock the framework against further saves (`stateFlushed`). */
  lockSaves(): void;
}

/**
 * The deck's half of an application quit, run to completion before the
 * host signals any child process.
 *
 * Four ordered phases:
 *
 *   1. **Interrupt** every session that reports `canInterrupt`, and wait
 *      for each to settle (bounded). Nothing else may run first: a turn
 *      that is still streaming when the process group dies is a rug pull,
 *      and a CASE A interrupt parks the user's un-answered submission in
 *      `pendingDraftRestore` — which only exists for the capture phase to
 *      find if the interrupt happened first.
 *   2. **Capture** through the teardown-save core with source
 *      `"termination"`, which is the tag that tells a card to fold in
 *      text it holds outside its visible surface (queued sends, the
 *      pulled-back submission from phase 1).
 *   3. **Retry** any card write tugbank rejected, within a bounded
 *      budget — quit routinely races the supervisor restarting tugcast.
 *   4. **Report** what actually happened. The host logs the verdict; it
 *      does not act on it.
 *
 * Never rejects and never blocks indefinitely: every wait is bounded and
 * early-exits, so a quit with nothing live and nothing dirty pays for
 * none of them. The manager memoizes the run so re-entrant calls join it.
 *
 * [L23] — this is the transition the whole plan exists to make safe.
 */
export async function runTerminationPipeline(deps: TerminationDeps): Promise<TerminationVerdict> {
  const startedAt = Date.now();

  const { interrupted, unacknowledged } = await deps.interruptLiveSessions();

  const attempted = new Set<string>();
  const first = await deps.teardownSave("termination", {
    layoutSave: "always",
    force: true,
  });
  for (const result of first.cards) attempted.add(result.cardId);

  let failedCards = first.cards.filter((r) => !r.ok).map((r) => r.cardId);
  let layoutSaved = first.layoutSaved;
  if (failedCards.length > 0 || !layoutSaved) {
    const retried = await retryFailedWrites(deps, attempted, layoutSaved);
    failedCards = retried.failedCards;
    layoutSaved = retried.layoutSaved;
  }

  // Lock the framework against further saves the way `saveAndFlushSync`
  // does — a late `beforeunload` must not re-open the bags this run
  // just closed.
  deps.lockSaves();

  return {
    ok: unacknowledged.length === 0 && failedCards.length === 0 && layoutSaved,
    interrupted,
    unacknowledged,
    flushedCards: attempted.size - failedCards.length,
    failedCards,
    layoutSaved,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Interrupt every live session and wait for each to settle, up to
 * {@link TERMINATION_INTERRUPT_AWAIT_MS}.
 *
 * It has two callers with the same need and one correct implementation.
 * The termination pipeline runs it because a quit ends every turn whether
 * or not anybody says so; the update wizard's *Stop work in flight* row
 * runs it (through `DeckManager.interruptLiveSessions`) because the user
 * asked to stop them. A second copy of "interrupt and wait, bounded" would
 * drift from this one the first time either changed.
 *
 * "Live" is the session's own published `canInterrupt` — [L28]: the
 * lifecycle owner decides what can be interrupted, and a caller that
 * re-derived the phase test would drift from it. In particular a
 * `replaying` session is deliberately excluded: the bracket window owns
 * the card, nothing durable is at risk (replay re-runs on the next boot),
 * and `handleInterrupt` has no `replaying` guard — an interrupt sent
 * there would reset the store to idle mid-replay.
 *
 * Settled is `phase ∈ {idle, errored}`: a CASE A interrupt reaches it
 * synchronously; a CASE B turn reaches it when the wire's
 * `turn_complete(error)` commits the interrupted entry. Every
 * subscription is released on acknowledgment *and* on expiry ([L27]).
 */
export async function interruptLiveSessions(): Promise<{
  interrupted: string[];
  unacknowledged: string[];
}> {
  const live = cardServicesStore
    .allServices()
    .map((services) => services.codeSessionStore)
    .filter((store) => store.getSnapshot().canInterrupt);

  if (live.length === 0) {
    return Promise.resolve({ interrupted: [], unacknowledged: [] });
  }

  return new Promise((resolve) => {
    const interrupted: string[] = [];
    const pending = new Map<CodeSessionStore, () => void>();
    let timer: number | null = null;

    const settled = (store: CodeSessionStore): boolean => {
      const phase = store.getSnapshot().phase;
      return phase === "idle" || phase === "errored";
    };

    const finish = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      const unacknowledged: string[] = [];
      for (const [store, unsubscribe] of pending) {
        unsubscribe();
        unacknowledged.push(store.getSnapshot().tugSessionId);
      }
      pending.clear();
      resolve({ interrupted, unacknowledged });
    };

    const acknowledge = (store: CodeSessionStore): void => {
      const unsubscribe = pending.get(store);
      if (unsubscribe === undefined) return;
      unsubscribe();
      pending.delete(store);
      interrupted.push(store.getSnapshot().tugSessionId);
      if (pending.size === 0) finish();
    };

    // Subscribe to every store before interrupting any of them: a CASE A
    // interrupt settles synchronously inside `interrupt()`, so a
    // subscribe-then-interrupt-per-store loop would let the first store's
    // acknowledgment see an incomplete pending set and finish early.
    for (const store of live) {
      pending.set(
        store,
        store.subscribe(() => {
          if (settled(store)) acknowledge(store);
        }),
      );
    }

    // Preserve each session's queued text before interrupting: a CASE A
    // interrupt clears `queuedSends`, so the capture phase would
    // otherwise find an empty queue for exactly the sessions that had
    // one.
    for (const store of live) {
      store.stashUnsentText();
      store.interrupt();
    }

    // Sweep for anything that settled without notifying us in a way we
    // observed (a synchronous settle during `interrupt()` is handled by
    // the subscription; this covers the rest).
    for (const store of Array.from(pending.keys())) {
      if (settled(store)) acknowledge(store);
    }

    if (pending.size === 0) return;
    timer = window.setTimeout(finish, TERMINATION_INTERRUPT_AWAIT_MS);
  });
}

/**
 * Re-attempt whatever tugbank rejected — card bags and the layout alike —
 * until it all lands or the budget runs out.
 *
 * The realistic reason a write fails at quit is that tugcast is
 * mid-restart (the supervisor's first backoff step is a second), so the
 * same outage takes down every write in the run and one retry pass
 * recovers all of them. `flushDirtyCardStates` re-marks a failed card
 * dirty, so each pass naturally targets exactly the outstanding cards;
 * the layout has no dirty bit, so it is simply re-sent until it sticks.
 *
 * Returns what is still failing when the budget expired, for the verdict
 * to report by name.
 */
async function retryFailedWrites(
  deps: TerminationDeps,
  attempted: Set<string>,
  layoutAlreadySaved: boolean,
): Promise<{ layoutSaved: boolean; failedCards: string[] }> {
  const deadline = Date.now() + TERMINATION_FLUSH_RETRY_BUDGET_MS;
  let layoutSaved = layoutAlreadySaved;
  let failed: string[] = [];
  while (Date.now() < deadline) {
    await new Promise<void>((r) =>
      window.setTimeout(() => r(), TERMINATION_FLUSH_RETRY_INTERVAL_MS),
    );
    if (!layoutSaved) layoutSaved = await deps.saveLayout();
    const results = await deps.flushDirtyCardStates({ force: true });
    for (const result of results) attempted.add(result.cardId);
    failed = results.filter((r) => !r.ok).map((r) => r.cardId);
    if (layoutSaved && failed.length === 0) return { layoutSaved, failedCards: [] };
  }
  return { layoutSaved, failedCards: failed };
}
