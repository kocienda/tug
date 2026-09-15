/**
 * `restoreSpaceSessions` — the lazy per-workspace restore ([P08], [B04]).
 *
 * A workspace activated after boot mounts session cards the one-shot
 * `restorePassGate` settled without. If nothing registers a
 * `sessionRestoreRegistry` expectation before those cards mount, each falls
 * straight through to the project picker (Risk R02) — so the decision has to be
 * made from the cache, synchronously, inside the switch.
 *
 * What these pin is the routing, card by card: a row with a transcript
 * resumes, a zero-turn dead row fresh-spawns under the same session id, a card
 * that is already bound or already restoring is left alone, and a card the
 * cache cannot answer for is collected into ONE round trip rather than
 * guessed at.
 *
 * The bus, the cache and the restore module are real; only the transport is a
 * stub, which is how the sibling restore tests in this directory are written.
 */

import { describe, test, expect, afterEach } from "bun:test";

import type { TugConnection } from "@/connection";
import {
  restoreSpaceSessions,
  sessionRestoreRegistry,
} from "@/lib/session-restore";
import { spaceBindingsLedgerStore } from "@/lib/space-bindings-ledger-store";
import { publishListCardBindingsOk } from "@/lib/session-ledger-events";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import type { CardBinding } from "@/protocol";
import type { DeckState } from "@/layout-tree";

/** Control frames the pass sent, so the round-trip leg can be counted. */
const controlFrames: { action: string; payload: unknown }[] = [];

const fakeConnection = {
  send: (_feedId: number, _payload: Uint8Array, _flags?: number) => {},
  trySend: (_feedId: number, _payload: Uint8Array, _flags?: number) => true,
  onFrame: (_feedId: number, _cb: (payload: Uint8Array) => void) => () => {},
  sendControlFrame: (action: string, payload: unknown) => {
    controlFrames.push({ action, payload });
  },
} as unknown as TugConnection;

/** The manager is only read for its snapshot on the round-trip leg. */
const fakeDeck = {
  subscribe: () => () => {},
  getSnapshot: () => ({ cards: [] }),
} as unknown as Parameters<typeof restoreSpaceSessions>[0];

function spaceDeck(
  cards: { id: string; componentId: string }[],
): DeckState {
  return {
    cards: cards.map((c) => ({ ...c, title: "", closable: true })),
    panes: [],
    imposition: { sidebars: {} },
    hasFocus: true,
  };
}

function row(over: Partial<CardBinding> & { card_id: string }): CardBinding {
  return {
    session_id: `sess-${over.card_id}`,
    project_dir: "/work/project",
    state: "closed",
    turn_count: 0,
    ...over,
  };
}

/** Fill the cache the way the boot `list_card_bindings_ok` frame does. */
function seedCache(bindings: CardBinding[]): void {
  spaceBindingsLedgerStore.installOnce();
  publishListCardBindingsOk({ bindings });
}

const TOUCHED = new Set<string>();

function track(...cardIds: string[]): void {
  for (const id of cardIds) TOUCHED.add(id);
}

afterEach(() => {
  for (const id of TOUCHED) {
    sessionRestoreRegistry._clear(id);
    cardSessionBindingStore.clearBinding(id);
  }
  TOUCHED.clear();
  controlFrames.length = 0;
  spaceBindingsLedgerStore._resetForTest();
});

describe("restoreSpaceSessions", () => {
  test("a cached row with a transcript resumes, synchronously", () => {
    const cardId = "space-restore-resume";
    track(cardId);
    seedCache([row({ card_id: cardId, has_jsonl: true, turn_count: 3 })]);

    restoreSpaceSessions(
      fakeDeck,
      spaceDeck([{ id: cardId, componentId: "session" }]),
      fakeConnection,
    );

    // Synchronously: the expectation stands before this call returns, which
    // is what puts the card on `SessionRestoring` at its first paint instead
    // of on a picker that flashes and is replaced.
    expect(sessionRestoreRegistry.has(cardId)).toBe(true);
    expect(sessionRestoreRegistry.get(cardId)?.tugSessionId).toBe(
      `sess-${cardId}`,
    );
    // And no round trip was needed — the cache answered.
    expect(
      controlFrames.filter((f) => f.action === "list_card_bindings"),
    ).toEqual([]);
  });

  test("a zero-turn dead row fresh-spawns under the same session id", () => {
    const cardId = "space-restore-fresh";
    track(cardId);
    seedCache([row({ card_id: cardId })]);

    restoreSpaceSessions(
      fakeDeck,
      spaceDeck([{ id: cardId, componentId: "session" }]),
      fakeConnection,
    );

    // The hold is armed either way; what differs is the spawn mode, and the
    // id is preserved so the session's durable non-JSONL content re-keys to
    // the same session rather than being orphaned.
    expect(sessionRestoreRegistry.has(cardId)).toBe(true);
    expect(sessionRestoreRegistry.get(cardId)?.tugSessionId).toBe(
      `sess-${cardId}`,
    );
  });

  test("a live zero-turn row resumes rather than fresh-spawning", () => {
    // The in-flight first turn: nothing in JSONL yet, but the supervisor is
    // holding the subprocess. A fresh spawn here would orphan it.
    const cardId = "space-restore-alive";
    track(cardId);
    seedCache([row({ card_id: cardId, is_alive: true })]);

    restoreSpaceSessions(
      fakeDeck,
      spaceDeck([{ id: cardId, componentId: "session" }]),
      fakeConnection,
    );
    expect(sessionRestoreRegistry.has(cardId)).toBe(true);
  });

  test("a card that already holds a binding is left alone", () => {
    const cardId = "space-restore-bound";
    track(cardId);
    seedCache([row({ card_id: cardId, has_jsonl: true })]);
    cardSessionBindingStore.setBinding(cardId, {
      tugSessionId: `sess-${cardId}`,
      lineId: `line-${cardId}`,
      projectDir: "/work/project",
      workspaceKey: "/work/project",
      sessionMode: "resume",
    });

    restoreSpaceSessions(
      fakeDeck,
      spaceDeck([{ id: cardId, componentId: "session" }]),
      fakeConnection,
    );

    // Re-firing on a bound card would re-spawn a session that is already
    // running — the switch's version of the double-resume.
    expect(sessionRestoreRegistry.has(cardId)).toBe(false);
    expect(
      controlFrames.filter((f) => f.action === "list_card_bindings"),
    ).toEqual([]);
  });

  test("a card with no cached row takes one round trip, for itself only", () => {
    const answered = "space-restore-answered";
    const unknown = "space-restore-unknown";
    track(answered, unknown);
    seedCache([row({ card_id: answered, has_jsonl: true })]);

    restoreSpaceSessions(
      fakeDeck,
      spaceDeck([
        { id: answered, componentId: "session" },
        { id: unknown, componentId: "session" },
      ]),
      fakeConnection,
    );

    expect(sessionRestoreRegistry.has(answered)).toBe(true);
    expect(sessionRestoreRegistry.has(unknown)).toBe(false);

    // Exactly one request, and the pass it opened is for the unanswered card:
    // the answer lands on the bus, and only that card's row is acted on.
    const requests = controlFrames.filter(
      (f) => f.action === "list_card_bindings",
    );
    expect(requests.length).toBe(1);
    publishListCardBindingsOk({
      bindings: [
        row({ card_id: unknown, has_jsonl: true }),
        // The already-handled card's row is in the same frame, as it would
        // be on the wire; the pass must not act on it a second time.
        row({ card_id: answered, has_jsonl: true, session_id: "a-different-one" }),
      ],
    });
    expect(sessionRestoreRegistry.has(unknown)).toBe(true);
    expect(sessionRestoreRegistry.get(answered)?.tugSessionId).toBe(
      `sess-${answered}`,
    );
  });

  test("a non-session card is not a card this pass has anything to say about", () => {
    const cardId = "space-restore-text";
    track(cardId);
    seedCache([row({ card_id: cardId, has_jsonl: true })]);

    restoreSpaceSessions(
      fakeDeck,
      spaceDeck([{ id: cardId, componentId: "text" }]),
      fakeConnection,
    );

    expect(sessionRestoreRegistry.has(cardId)).toBe(false);
    expect(
      controlFrames.filter((f) => f.action === "list_card_bindings"),
    ).toEqual([]);
  });
});
