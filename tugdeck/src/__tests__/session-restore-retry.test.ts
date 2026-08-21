/**
 * `session-restore` — bounded automatic retry of a failed restore.
 *
 * Before this, a restore that timed out or was rejected dropped the
 * card to the picker permanently, on the stated assumption that "the
 * next reload retries" — the recovery plan was the user restarting the
 * app, which is exactly what makes it unsafe to start a long turn and
 * walk away. These tests pin the replacement: bounded retry with
 * backoff, and a re-query before every re-spawn.
 *
 * The restore module, the ledger-event bus, and the picker-notice
 * store are all real. Only the transport is a stub — the test drives
 * the `list_card_bindings_ok` response through the real bus — and
 * `setTimeout` is replaced with a table the test steps by hand, since
 * the backoff schedule is measured in seconds.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import type { TugConnection } from "@/connection";
import type { DeckManager } from "@/deck-manager";
import {
  cancelRestoreRetry,
  fireRestore,
  restoreSessions,
  sessionRestoreRegistry,
} from "@/lib/session-restore";
import { publishListCardBindingsOk } from "@/lib/session-ledger-events";
import { pickerNoticeStore } from "@/lib/picker-notice-store";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { FeedId } from "@/protocol";
import type { CardBinding } from "@/protocol";

// ---------------------------------------------------------------------------
// Transport stub — records what the module put on the wire.
// ---------------------------------------------------------------------------

let sentFrames: number[];
let controlActions: string[];

/**
 * SESSION_STATE handlers the restore module installed. Never reset
 * between tests: `installRegistrySubscriptions` is guarded to run once
 * per module load, so a per-test reset would leave every test after
 * the first with no handler and silently pass on nothing.
 */
const sessionStateHandlers: Array<(payload: Uint8Array) => void> = [];

const fakeConnection = {
  send: (feedId: number, _payload: Uint8Array, _flags?: number) => {
    sentFrames.push(feedId);
  },
  trySend: (feedId: number, _payload: Uint8Array, _flags?: number) => {
    sentFrames.push(feedId);
    return true;
  },
  onFrame: (feedId: number, cb: (payload: Uint8Array) => void) => {
    if (feedId === FeedId.SESSION_STATE) sessionStateHandlers.push(cb);
    return () => {};
  },
  sendControlFrame: (action: string, _payload: unknown) => {
    controlActions.push(action);
  },
} as unknown as TugConnection;

/** Deliver an errored SESSION_STATE the way tugcast would. */
function deliverSessionErrored(detail: string): void {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      tug_session_id: SESSION,
      state: "errored",
      detail,
    }),
  );
  for (const cb of sessionStateHandlers) cb(payload);
}

// ---------------------------------------------------------------------------
// Hand-stepped timer table.
// ---------------------------------------------------------------------------

interface PendingTimer {
  id: number;
  cb: () => void;
  dueAt: number;
}

let timers: Map<number, PendingTimer>;
let nextTimerId: number;
let clock: number;

let origSetTimeout: typeof globalThis.setTimeout;
let origClearTimeout: typeof globalThis.clearTimeout;

function installTimers(): void {
  timers = new Map();
  nextTimerId = 1;
  clock = 0;
  origSetTimeout = globalThis.setTimeout;
  origClearTimeout = globalThis.clearTimeout;

  (globalThis as unknown as {
    setTimeout: (cb: () => void, ms: number) => number;
  }).setTimeout = (cb: () => void, ms: number): number => {
    const id = nextTimerId++;
    timers.set(id, { id, cb, dueAt: clock + ms });
    return id;
  };
  (globalThis as unknown as { clearTimeout: (id?: number) => void })
    .clearTimeout = (id?: number): void => {
      if (id !== undefined) timers.delete(id);
    };
}

function uninstallTimers(): void {
  globalThis.setTimeout = origSetTimeout;
  globalThis.clearTimeout = origClearTimeout;
}

/** Advance the clock, firing every timer that falls due, in order. */
function advance(ms: number): void {
  const target = clock + ms;
  for (;;) {
    let next: PendingTimer | null = null;
    for (const t of timers.values()) {
      if (t.dueAt <= target && (next === null || t.dueAt < next.dueAt)) {
        next = t;
      }
    }
    if (next === null) break;
    timers.delete(next.id);
    clock = next.dueAt;
    next.cb();
  }
  clock = target;
}

const RESTORE_TIMEOUT_MS = 20_000;
/** Long enough to clear the longest backoff plus a query round-trip. */
const PAST_ALL_BACKOFF_MS = 60_000;

const CARD = "card-retry-test";
const SESSION = "sess-retry-test";
const PROJECT = "/tmp/retry-test";

function binding(overrides: Partial<CardBinding> = {}): CardBinding {
  return {
    card_id: CARD,
    session_id: SESSION,
    project_dir: PROJECT,
    state: "closed",
    turn_count: 3,
    has_jsonl: true,
    ...overrides,
  };
}

/**
 * Install the module's SESSION_STATE subscriber by running a restore
 * pass over an empty deck. The pass settles immediately (no session
 * cards), but `installRegistrySubscriptions` runs first and registers
 * the handler the rejection tests drive.
 */
function installSessionStateSubscriber(): void {
  if (sessionStateHandlers.length > 0) return;
  const emptyDeck = {
    subscribe: (_cb: () => void) => () => {},
    getSnapshot: () => ({ cards: [] as Array<{ id: string; componentId: string }> }),
  };
  restoreSessions(emptyDeck as unknown as DeckManager, fakeConnection);
}

/** Drive a restore to its timeout, which is what schedules attempt 1. */
function restoreThenTimeOut(): void {
  fireRestore(CARD, SESSION, PROJECT, fakeConnection);
  advance(RESTORE_TIMEOUT_MS);
}

describe("session-restore — automatic retry", () => {
  beforeEach(() => {
    installTimers();
    sentFrames = [];
    controlActions = [];
    pickerNoticeStore.consume(CARD);
    cardSessionBindingStore.clearBinding(CARD);
  });

  afterEach(() => {
    cancelRestoreRetry(CARD);
    sessionRestoreRegistry._clear(CARD);
    pickerNoticeStore.consume(CARD);
    cardSessionBindingStore.clearBinding(CARD);
    uninstallTimers();
  });

  it("a timed-out restore retries instead of dropping to the picker", () => {
    restoreThenTimeOut();

    // The hold is gone, but so is the old outcome: no picker notice
    // yet, because the card has not given up.
    expect(sessionRestoreRegistry.has(CARD)).toBe(false);
    expect(pickerNoticeStore.consume(CARD)).toBeNull();

    // The first backoff elapses and the retry re-queries rather than
    // blindly re-spawning.
    controlActions = [];
    advance(2_000);
    expect(controlActions).toContain("list_card_bindings");
  });

  it("re-queries first and skips the spawn when the card is already bound", () => {
    restoreThenTimeOut();
    advance(2_000);

    // The listing says a live subprocess holds this card — the
    // original spawn landed late while we were being impatient.
    sentFrames = [];
    publishListCardBindingsOk({ bindings: [binding({ is_alive: true })] });

    expect(sentFrames.length).toBe(0);

    // And the retry is finished: nothing further fires.
    controlActions = [];
    advance(PAST_ALL_BACKOFF_MS);
    expect(controlActions).toEqual([]);
  });

  it("re-fires the spawn exactly once when the listing shows the card unbound", () => {
    restoreThenTimeOut();
    advance(2_000);

    sentFrames = [];
    publishListCardBindingsOk({ bindings: [] });

    expect(sentFrames.length).toBe(1);
    expect(sessionRestoreRegistry.has(CARD)).toBe(true);
  });

  it("gives up after three retries with exactly one picker notice", () => {
    restoreThenTimeOut();

    // Each round: backoff elapses → re-query → listing says unbound →
    // spawn re-fires → that spawn times out too.
    for (const backoff of [2_000, 6_000, 15_000]) {
      advance(backoff);
      publishListCardBindingsOk({ bindings: [] });
      advance(RESTORE_TIMEOUT_MS);
    }

    const notice = pickerNoticeStore.consume(CARD);
    expect(notice?.category).toBe("restore_timed_out");
    expect(notice?.staleTugSessionId).toBe(SESSION);

    // Budget spent — no further attempts are made.
    controlActions = [];
    advance(PAST_ALL_BACKOFF_MS);
    expect(controlActions).toEqual([]);
  });

  it("a binding landing while a retry is pending disarms it", () => {
    restoreThenTimeOut();

    // The restore succeeded on the attempt we had stopped waiting for.
    cancelRestoreRetry(CARD);

    controlActions = [];
    sentFrames = [];
    advance(PAST_ALL_BACKOFF_MS);

    expect(controlActions).toEqual([]);
    expect(sentFrames).toEqual([]);
  });

  it("a terminal gate rejection goes straight to the picker with no retry", () => {
    // A session held open in a terminal will still be held open on the
    // third attempt. Retrying only turns a fast, legible message into
    // three slow ones.
    installSessionStateSubscriber();
    fireRestore(CARD, SESSION, PROJECT, fakeConnection);

    deliverSessionErrored("session_live_in_terminal");

    const notice = pickerNoticeStore.consume(CARD);
    expect(notice?.category).toBe("resume_failed");
    expect(notice?.message).toContain("terminal");

    controlActions = [];
    sentFrames = [];
    advance(PAST_ALL_BACKOFF_MS);
    expect(controlActions).toEqual([]);
    expect(sentFrames).toEqual([]);
  });

  it("an unclassified rejection is treated as possibly transient and retried", () => {
    installSessionStateSubscriber();
    fireRestore(CARD, SESSION, PROJECT, fakeConnection);

    deliverSessionErrored("ledger_busy");

    // No verdict yet — the card has not given up.
    expect(pickerNoticeStore.consume(CARD)).toBeNull();

    controlActions = [];
    advance(2_000);
    expect(controlActions).toContain("list_card_bindings");
  });

  it("the attempt counter resets, so a later failure gets a full budget", () => {
    restoreThenTimeOut();
    advance(2_000);
    publishListCardBindingsOk({ bindings: [binding({ is_alive: true })] });

    // A fresh failure much later starts over rather than inheriting
    // the spent attempt.
    restoreThenTimeOut();
    controlActions = [];
    advance(2_000);
    expect(controlActions).toContain("list_card_bindings");
  });
});
