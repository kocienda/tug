/**
 * Which cards a restore pass names for the restore gate's total.
 *
 * The gate counts sessions over a total fixed when its round opens, and the
 * restore pass is what knows that total before any page exists: it writes
 * the shown cards it resumed into `restoreGateRoster`. A card counts there
 * only when the pass's own `fireRestore` made its page — a resume (not a
 * fresh spawn), a card the shell did not defer (an inactive tab restores
 * when it is shown), and a card with no page before (a page that already
 * exists is handed its resume over the bus and has painted before its body
 * can say its restore is still to come).
 *
 * The bus, the hand-off and the restore module are real; the transport and
 * the host's page request are stubs, as in the sibling restore tests. The
 * names are recorded as the pass writes them, since the restore gate's store
 * drains the roster on its own notify whenever another file has woken it.
 *
 * @covers tugdeck/src/lib/session-restore.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { TugConnection } from "@/connection";
import type { IDeckManagerStore } from "@/deck-manager-store";
import type { DeckState } from "@/layout-tree";
import type { CardBinding } from "@/protocol";
import { registerCard } from "@/card-registry";
import {
  restoreSessions,
  restoreSpaceSessions,
  sessionRestoreRegistry,
} from "@/lib/session-restore";
import { publishListCardBindingsOk } from "@/lib/session-ledger-events";
import { spaceBindingsLedgerStore } from "@/lib/space-bindings-ledger-store";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { bodyCardsStore } from "@/lib/body-cards-store";
import {
  _resetHandOffForTest,
  _setHostCapabilitiesForTest,
  setBodyDeferral,
} from "@/lib/body-handoff";
import { registerShellDeck } from "@/lib/deck-store-registry";
import { restoreGateRoster } from "@/lib/restore-gate-roster";
import { restoreGateStore } from "@/lib/restore-gate-store";

// A kind of this file's own, so the shell's deck can hold body cards without
// depending on, or disturbing, another file's registration of a real kind.
registerCard({
  componentId: "roster-session",
  contentFactory: () => null,
  defaultMeta: { title: "Session", closable: true },
  bodyHandOff: "spawn",
});

const [A, B, C, D] = ["roster-a", "roster-b", "roster-c", "roster-d"];
const CARDS = [A, B, C, D];

const shellDeck = { cards: CARDS.map((id) => ({ id, componentId: "roster-session" })) };
const deck = {
  getSnapshot: () => shellDeck,
  spaceOf: () => null,
  getSpaceDeck: () => shellDeck,
  getCardState: () => undefined,
} as unknown as IDeckManagerStore;

const connection = {
  send: () => {},
  trySend: () => true,
  onFrame: () => () => {},
  sendControlFrame: () => {},
} as unknown as TugConnection;

function binding(over: Partial<CardBinding> & { card_id: string }): CardBinding {
  return {
    session_id: `sess-${over.card_id}`,
    project_dir: "/work/project",
    state: "closed",
    turn_count: 0,
    ...over,
  };
}

/** A and B resume, C fresh-spawns, D resumes onto a page that already exists. */
const BINDINGS: CardBinding[] = [
  binding({ card_id: A, has_jsonl: true }),
  binding({ card_id: B, has_jsonl: true }),
  binding({ card_id: C }),
  binding({ card_id: D, has_jsonl: true }),
];

const g = globalThis as { webkit?: unknown };
let priorWebkit: unknown;

/** What the pass named, in order, recorded as it names them. */
let named: string[] = [];
const expectNames = restoreGateRoster.expect;

beforeEach(() => {
  priorWebkit = g.webkit;
  g.webkit = { messageHandlers: { bodyCreate: { postMessage: () => {} } } };
  _setHostCapabilitiesForTest({ bodyViews: true });
  registerShellDeck(deck);
  _resetHandOffForTest();
  bodyCardsStore._reset();
  for (const id of CARDS) {
    sessionRestoreRegistry._clear(id);
    cardSessionBindingStore.clearBinding(id);
  }
  // B is an inactive tab: not shown, so not restored until it is.
  setBodyDeferral((cardId) => cardId === B);
  // D's page is already there and has painted.
  bodyCardsStore.mark(D);
  bodyCardsStore.setState(D, "painted");
  restoreGateRoster.take();
  named = [];
  restoreGateRoster.expect = (ids: Iterable<string>) => {
    const list = [...ids];
    named.push(...list);
    expectNames.call(restoreGateRoster, list);
  };
});

afterEach(() => {
  restoreGateRoster.expect = expectNames;
  for (const id of CARDS) {
    sessionRestoreRegistry._clear(id);
    cardSessionBindingStore.clearBinding(id);
  }
  restoreGateRoster.take();
  restoreGateStore._resetForTest();
  spaceBindingsLedgerStore._resetForTest();
  bodyCardsStore._reset();
  registerShellDeck(null);
  _setHostCapabilitiesForTest({ bodyViews: false });
  _resetHandOffForTest();
  g.webkit = priorWebkit;
});

describe("the restore pass names the shown cards whose page it made", () => {
  test("restoreSessions", () => {
    restoreSessions(deck, connection, { cardIds: new Set(CARDS) });
    publishListCardBindingsOk({ bindings: BINDINGS });
    expect(named).toEqual([A]);
  });

  test("restoreSpaceSessions", () => {
    spaceBindingsLedgerStore.installOnce();
    publishListCardBindingsOk({ bindings: BINDINGS });
    const spaceDeck: DeckState = {
      cards: CARDS.map((id) => ({ id, componentId: "session", title: "", closable: true })),
      panes: [],
      imposition: { sidebars: {} },
      hasFocus: true,
    } as unknown as DeckState;
    restoreSpaceSessions(deck as never, spaceDeck, connection);
    expect(named).toEqual([A]);
  });
});
