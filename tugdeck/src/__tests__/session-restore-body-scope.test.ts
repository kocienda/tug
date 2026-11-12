/**
 * A body page's restore pass acts for its own card alone. An arrangement
 * body's deck is its whole workspace's deck, and the Cards card's body is
 * handed every card's bindings row, so a pass that took every Session card
 * of its deck would resume sessions that belong to other cards' pages — and
 * the shell, sent acks it never asked for, would build stores for a parked
 * card no page draws. A Session body still re-asserts its own card, and the
 * shell's pass is unchanged.
 *
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/body/body-main.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TugConnection } from "../connection";
import { _resetPageForTest, installPage } from "../bus/page";
import { CARDS_CARD_ID } from "../lib/cards-card-id";
import { restoreSessions, sessionRestoreRegistry } from "../lib/session-restore";
import { publishListCardBindingsOk } from "../lib/session-ledger-events";

let controlActions: string[];

const connection = {
  // A CONTROL frame is JSON naming its action; record that.
  send: (_feedId: number, payload: Uint8Array) => {
    const action = (JSON.parse(new TextDecoder().decode(payload)) as { action?: string }).action;
    if (action !== undefined) controlActions.push(action);
  },
  trySend: () => true,
  onFrame: () => () => {},
  sendControlFrame: (action: string) => {
    controlActions.push(action);
  },
} as unknown as TugConnection;

type Card = { id: string; componentId: string };
const deckOf = (cards: Card[]) => ({ getSnapshot: () => ({ cards }) }) as never;

/** The Cards card's arrangement deck: its workspace's whole deck. */
const workspaceDeck = deckOf([
  { id: "cards-1", componentId: CARDS_CARD_ID },
  { id: "s1", componentId: "session" },
  { id: "s2", componentId: "session" },
]);

const row = (cardId: string) => ({
  card_id: cardId,
  session_id: `tug-${cardId}`,
  project_dir: "/p",
  turn_count: 3,
  state: "live" as const,
  has_jsonl: true,
});

/** Answer the pass as the Cards body's filter would: the whole list. */
function answerWithEveryRow(): void {
  publishListCardBindingsOk({ bindings: [row("s1"), row("s2")] });
}

const spawns = () => controlActions.filter((a) => a === "spawn_session");

beforeEach(() => {
  controlActions = [];
});

afterEach(() => {
  _resetPageForTest();
  for (const id of ["cards-1", "s1", "s2"]) sessionRestoreRegistry._clear(id);
});

describe("an arrangement body's restore pass", () => {
  test("the Cards body's reconnect resumes no other card's session (server restart)", () => {
    installPage({ role: "body", cardId: "cards-1", componentId: CARDS_CARD_ID });
    restoreSessions(workspaceDeck, connection, { reason: "server-restart", reassert: true });
    answerWithEveryRow();
    expect(spawns()).toEqual([]);
  });

  test("the same, on a same-server reconnect", () => {
    installPage({ role: "body", cardId: "cards-1", componentId: CARDS_CARD_ID });
    restoreSessions(workspaceDeck, connection, { reason: "launch", rebind: true, reassert: true });
    answerWithEveryRow();
    expect(spawns()).toEqual([]);
  });
});

describe("a Session body's restore pass", () => {
  test("a Session body still re-asserts its own card", () => {
    installPage({ role: "body", cardId: "s1", componentId: "session" });
    restoreSessions(deckOf([{ id: "s1", componentId: "session" }]), connection, {
      reason: "server-restart",
      reassert: true,
    });
    answerWithEveryRow();
    expect(spawns()).toEqual(["spawn_session"]);
  });
});

describe("the shell's restore pass", () => {
  test("the shell's pass is unchanged", () => {
    restoreSessions(workspaceDeck, connection, { reason: "server-restart", reassert: true });
    answerWithEveryRow();
    expect(spawns()).toEqual(["spawn_session", "spawn_session"]);
  });
});
