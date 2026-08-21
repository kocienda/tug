/**
 * `session-restore` — zero-turn fresh-spawn restore hold.
 *
 * On a cold relaunch, `restoreSessions` resolves each ledger
 * binding by `turn_count`: `> 0` resumes the JSONL, `=== 0` fires a
 * fresh `spawn_session(mode=new)` under the same project AND the same
 * session id (F1 — preserving the id re-keys the session's durable
 * non-JSONL content instead of orphaning it). The fresh path starts a
 * JSONL-less session — there is nothing to "restore" from JSONL — but
 * the card is still mid-bind: until `spawn_session_ok` lands, an unbound
 * session card with no `sessionRestoreRegistry` entry falls straight through
 * to the project picker, flashing its `TugSheet` for the round-trip.
 *
 * These tests pin the production wire that closes that window: the
 * zero-turn branch arms a `sessionRestoreRegistry` hold (so
 * `SessionCardContent` shows the quiet `SessionRestoring` backdrop), and
 * `notifySpawnRejected` drops the hold when tugcast rejects the spawn
 * so the card can fall through to the picker + its error banner.
 *
 * The bus + restore module are real; only the transport
 * (`connection`) is a no-op stub.
 */

import { describe, it, expect, afterEach } from "bun:test";

import type { TugConnection } from "@/connection";
import {
  restoreSessions,
  notifySpawnRejected,
  sessionRestoreRegistry,
} from "@/lib/session-restore";
import { publishListCardBindingsOk } from "@/lib/session-ledger-events";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import type { CardBinding } from "@/protocol";

// The restore pass only reaches the transport for `send` (the
// `spawn_session` frame), `onFrame` (the SESSION_STATE subscriber),
// and `sendControlFrame` (the `list_card_bindings` request). All three
// are no-ops here — the test drives the response directly via the bus.
const fakeConnection = {
  send: (_feedId: number, _payload: Uint8Array, _flags?: number) => {},
  trySend: (_feedId: number, _payload: Uint8Array, _flags?: number) => true,
  onFrame: (_feedId: number, _cb: (payload: Uint8Array) => void) => () => {},
  sendControlFrame: (_action: string, _payload: unknown) => {},
} as unknown as TugConnection;

interface FakeCard {
  id: string;
  componentId: string;
}

function createFakeDeck(cards: FakeCard[]) {
  const snapshot = { cards };
  return {
    subscribe(_cb: () => void): () => void {
      return () => {};
    },
    getSnapshot(): { cards: FakeCard[] } {
      return snapshot;
    },
  };
}

function zeroTurnBinding(cardId: string, projectDir: string): CardBinding {
  return {
    card_id: cardId,
    session_id: `sess-${cardId}`,
    project_dir: projectDir,
    state: "closed",
    turn_count: 0,
  };
}

function zeroTurnLiveBinding(
  cardId: string,
  projectDir: string,
): CardBinding {
  return {
    card_id: cardId,
    session_id: `sess-${cardId}`,
    project_dir: projectDir,
    state: "live",
    turn_count: 0,
    is_alive: true,
  };
}

const TOUCHED_CARD_IDS = new Set<string>();

function runRestore(cardId: string, projectDir: string): void {
  TOUCHED_CARD_IDS.add(cardId);
  const deck = createFakeDeck([{ id: cardId, componentId: "session" }]);
  restoreSessions(
    deck as unknown as Parameters<typeof restoreSessions>[0],
    fakeConnection,
  );
  publishListCardBindingsOk({ bindings: [zeroTurnBinding(cardId, projectDir)] });
}

afterEach(() => {
  // Drop registry entries (and their armed timeout timers) so a
  // zero-turn hold from one test cannot leak into the next. Clearing the
  // binding disposes the card's services bag with it — the shell and refs
  // stores each own a retrying restore fetch ([P07]), which would otherwise
  // keep ticking long after this file is done.
  for (const id of TOUCHED_CARD_IDS) {
    sessionRestoreRegistry._clear(id);
    cardSessionBindingStore.clearBinding(id);
  }
  TOUCHED_CARD_IDS.clear();
});

describe("session-restore — zero-turn fresh-spawn hold", () => {
  it("arms a restore-registry hold for a zero-turn binding", () => {
    const cardId = "session-fresh-card-1";
    const projectDir = "/work/fresh-spawn";
    expect(sessionRestoreRegistry.has(cardId)).toBe(false);

    runRestore(cardId, projectDir);

    // Without the hold the card would fall through to the picker the
    // instant the pass gate settles; the entry keeps it on the quiet
    // `SessionRestoring` backdrop until the bind lands.
    expect(sessionRestoreRegistry.has(cardId)).toBe(true);
    expect(sessionRestoreRegistry.get(cardId)?.projectDir).toBe(projectDir);
    // F1: the fresh-spawn PRESERVES the bound session id (does not mint a
    // fresh UUID), so the session's durable non-JSONL content — the shell
    // ledger, `/btw` history, staged-context queue, all keyed by
    // tug_session_id — re-keys to the same session instead of orphaning.
    expect(sessionRestoreRegistry.get(cardId)?.tugSessionId).toBe(
      `sess-${cardId}`,
    );
  });

  it("notifySpawnRejected drops the hold so the picker can present", () => {
    const cardId = "session-fresh-card-2";
    runRestore(cardId, "/work/missing-dir");
    expect(sessionRestoreRegistry.has(cardId)).toBe(true);

    // tugcast rejected the spawn (e.g. the project directory is gone).
    notifySpawnRejected(cardId);

    expect(sessionRestoreRegistry.has(cardId)).toBe(false);
  });

  it("notifySpawnRejected is a no-op for a card with no hold", () => {
    expect(() => notifySpawnRejected("session-card-never-restored")).not.toThrow();
  });

  it("zero-turn binding with is_alive=true takes the resume path (in-flight first turn)", () => {
    // This is the in-flight-first-turn case: the user submitted, claude
    // is mid-response or blocked on a permission/question
    // control_request, the live tugcode subprocess holds runtime state,
    // but no turn has committed to JSONL yet. `turn_count` is zero but
    // `is_alive` is true; the gate must resume (not fresh-spawn) so the
    // card rejoins the live session.
    const cardId = "session-inflight-card";
    const projectDir = "/work/inflight";
    TOUCHED_CARD_IDS.add(cardId);

    const deck = createFakeDeck([{ id: cardId, componentId: "session" }]);
    restoreSessions(
      deck as unknown as Parameters<typeof restoreSessions>[0],
      fakeConnection,
    );
    publishListCardBindingsOk({
      bindings: [zeroTurnLiveBinding(cardId, projectDir)],
    });

    // Resume path arms the same hold as turn_count > 0; without the
    // hold the card would fall through to the picker before the bind
    // ack lands.
    expect(sessionRestoreRegistry.has(cardId)).toBe(true);
    expect(sessionRestoreRegistry.get(cardId)?.tugSessionId).toBe(
      `sess-${cardId}`,
    );
  });
});

describe("session-restore — has_jsonl resume gating", () => {
  // Capture the `spawn_session` frame's `session_mode` for a binding by
  // decoding the JSON payload the restore pass sends (controlFrame encodes
  // `{ action, ...params }` as JSON bytes).
  function spawnModeFor(binding: CardBinding): string | undefined {
    const sent: string[] = [];
    const capturing = {
      send: (_feedId: number, payload: Uint8Array) => {
        sent.push(new TextDecoder().decode(payload));
      },
      trySend: (_feedId: number, payload: Uint8Array) => {
        sent.push(new TextDecoder().decode(payload));
        return true;
      },
      onFrame: () => () => {},
      sendControlFrame: () => {},
    } as unknown as TugConnection;
    TOUCHED_CARD_IDS.add(binding.card_id);
    const deck = createFakeDeck([{ id: binding.card_id, componentId: "session" }]);
    restoreSessions(
      deck as unknown as Parameters<typeof restoreSessions>[0],
      capturing,
    );
    publishListCardBindingsOk({ bindings: [binding] });
    return sent
      .map((s) => JSON.parse(s) as { action?: string; session_mode?: string })
      .find((f) => f.action === "spawn_session")?.session_mode;
  }

  it("a zero-turn binding WITH has_jsonl resumes (does not fresh-spawn)", () => {
    // The pretty-earth-2 regression: claude wrote a full transcript but the
    // ledger's live `record_turn` counter stayed 0, so `turn_count === 0`.
    // Gating on `turn_count` alone fresh-spawned it (`mode=new`), whose
    // `--session-id` collided with the on-disk JSONL and crash-looped the
    // card to `errored`. `has_jsonl` must route it to resume.
    expect(
      spawnModeFor({
        card_id: "session-hasjsonl-card",
        session_id: "sess-hasjsonl",
        project_dir: "/work/hasjsonl",
        state: "closed",
        turn_count: 0,
        has_jsonl: true,
      }),
    ).toBe("resume");
  });

  it("a zero-turn binding with neither has_jsonl nor is_alive fresh-spawns", () => {
    expect(
      spawnModeFor({
        card_id: "session-nojsonl-card",
        session_id: "sess-nojsonl",
        project_dir: "/work/nojsonl",
        state: "closed",
        turn_count: 0,
      }),
    ).toBe("new");
  });
});
