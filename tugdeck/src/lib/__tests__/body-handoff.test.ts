/**
 * A Session card is handed to a body at its spawn funnel, and only then:
 * with no body capability the funnel sends as it always did; with it, a
 * Session card becomes a body card once and the funnel sends nothing, a card
 * of another kind and a card whose body failed stay in the shell, and the
 * reconnect pass's second fire for a body card asks the host for nothing.
 * The intent a card was handed is kept while it is a body card, so a body
 * that failed before its session was bound can re-run it in the shell, and a
 * bound card's arrival waits on its body's ready, or its failure.
 *
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/body/body-intent.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { replayBodyIntent } from "../../body/body-intent";
import type { TugConnection } from "../../connection";
import type { IDeckManagerStore } from "../../deck-manager-store";
import { BodyCardsStore, bodyCardsStore, bodyReadyQuiet } from "../body-cards-store";
import {
  _resetHandOffForTest,
  _setHostCapabilitiesForTest,
  bodyIntentOf,
  forgetBodyIntent,
  suppressHandOff,
} from "../body-handoff";
import { registerDeckStore } from "../deck-store-registry";
import {
  drainOpeningCommand,
  fireFreshSpawn,
  fireNewSpawn,
  fireRestore,
  sessionRestoreRegistry,
  stashOpeningCommand,
} from "../session-restore";

let controlActions: string[];
let posted: Array<{ name: string; body: unknown }>;

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

const deck = {
  getSnapshot: () => ({
    cards: [
      { id: "s1", componentId: "session" },
      { id: "s2", componentId: "session" },
      { id: "g1", componentId: "git" },
    ],
  }),
} as unknown as IDeckManagerStore;

const g = globalThis as { webkit?: unknown };
let priorWebkit: unknown;

beforeEach(() => {
  controlActions = [];
  posted = [];
  priorWebkit = g.webkit;
  const handler = (name: string) => ({
    postMessage: (body: unknown) => posted.push({ name, body }),
  });
  g.webkit = { messageHandlers: { bodyCreate: handler("bodyCreate") } };
  registerDeckStore(deck);
  _resetHandOffForTest();
});

afterEach(() => {
  for (const id of ["s1", "s2", "g1"]) sessionRestoreRegistry._clear(id);
  g.webkit = priorWebkit;
  registerDeckStore(null);
  _setHostCapabilitiesForTest({ bodyViews: false });
  _resetHandOffForTest();
});

describe("without the capability", () => {
  test("nothing is handed off and the funnel sends as before", () => {
    _setHostCapabilitiesForTest({ bodyViews: false });
    fireRestore("s1", "tug-1", "/p", connection);
    expect(controlActions).toEqual(["spawn_session"]);
    expect(posted).toEqual([]);
    expect(bodyCardsStore.has("s1")).toBe(false);
  });
});

describe("with the capability", () => {
  beforeEach(() => {
    _setHostCapabilitiesForTest({ bodyViews: true });
  });

  test("a Session card is handed off once, with the funnel's intent", () => {
    fireRestore("s1", "tug-1", "/p", connection);
    expect(controlActions).toEqual([]);
    expect(posted).toEqual([
      { name: "bodyCreate", body: { cardId: "s1", intent: { kind: "resume", tugSessionId: "tug-1", projectDir: "/p" } } },
    ]);
    expect(bodyCardsStore.stateOf("s1")).toBe("creating");
  });

  test("a fresh spawn carries its stashed opening command into the intent", () => {
    stashOpeningCommand("s1", { name: "arc", args: "go" });
    fireFreshSpawn("s1", "tug-1", "/p", connection);
    expect(controlActions).toEqual([]);
    expect(posted[0]?.body).toEqual({
      cardId: "s1",
      intent: { kind: "fresh", tugSessionId: "tug-1", projectDir: "/p", openingCommand: { name: "arc", args: "go" } },
    });
    expect(drainOpeningCommand("s1")).toBeUndefined();
  });

  test("a new spawn carries the line and tag the shell minted", () => {
    fireNewSpawn("s2", "tug-2", "/p", connection, { lineId: "line-2", tag: "odd-kiln" });
    expect(controlActions).toEqual([]);
    expect(posted[0]?.body).toEqual({
      cardId: "s2",
      intent: { kind: "new", tugSessionId: "tug-2", projectDir: "/p", lineId: "line-2", tag: "odd-kiln" },
    });
  });

  test("a card of another kind is never handed off", () => {
    fireRestore("g1", "tug-3", "/p", connection);
    expect(controlActions).toEqual(["spawn_session"]);
    expect(posted).toEqual([]);
  });

  test("a card whose body failed stays in the shell", () => {
    suppressHandOff("s1");
    fireRestore("s1", "tug-1", "/p", connection);
    expect(controlActions).toEqual(["spawn_session"]);
    expect(posted).toEqual([]);
  });

  test("the reconnect pass's second fire for a body card posts nothing and sends nothing", () => {
    fireRestore("s1", "tug-1", "/p", connection);
    posted = [];
    fireRestore("s1", "tug-1", "/p", connection);
    fireFreshSpawn("s1", "tug-1", "/p", connection);
    expect(posted).toEqual([]);
    expect(controlActions).toEqual([]);
  });

  test("the intent a card was handed is kept until the card is no longer a body card", () => {
    fireNewSpawn("s2", "tug-2", "/p", connection, { lineId: "line-2", tag: "odd-kiln" });
    expect(bodyIntentOf("s2")).toEqual({
      kind: "new",
      tugSessionId: "tug-2",
      projectDir: "/p",
      lineId: "line-2",
      tag: "odd-kiln",
    });
    forgetBodyIntent("s2");
    expect(bodyIntentOf("s2")).toBeNull();
  });

  test("a failed card's intent re-runs through the shell's funnel, on the shell's whole connection", () => {
    // The recorded connection has no `setSessions`: a replay that narrowed
    // the shell's subscriptions to one session would throw here.
    fireNewSpawn("s2", "tug-2", "/p", connection, { lineId: "line-2", tag: "odd-kiln" });
    const intent = bodyIntentOf("s2")!;
    suppressHandOff("s2");
    bodyCardsStore.drop("s2");
    posted = [];
    replayBodyIntent(intent, "s2", connection, deck, { inShell: true });
    expect(posted).toEqual([]);
    expect(controlActions).toEqual(["spawn_session"]);
  });
});

describe("bodyReadyQuiet", () => {
  test("is quiet when the body is ready, and when it failed and the card was taken back", () => {
    const store = new BodyCardsStore();
    const quiet = bodyReadyQuiet("c1", store);
    let fires = 0;
    const release = quiet.subscribe(() => fires++);
    expect(quiet.isQuiet()).toBe(false);
    store.mark("c1");
    expect(quiet.isQuiet()).toBe(false);
    store.setState("c1", "ready");
    expect(quiet.isQuiet()).toBe(true);
    expect(fires).toBe(2);

    const failing = bodyReadyQuiet("c2", store);
    const releaseFailing = failing.subscribe(() => {});
    store.mark("c2");
    store.setState("c2", "failed");
    store.drop("c2");
    expect(failing.isQuiet()).toBe(true);
    release();
    releaseFailing();
  });
});
