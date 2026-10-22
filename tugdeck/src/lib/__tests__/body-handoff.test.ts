/**
 * A card of a registered kind is handed to a body — a spawn kind at its spawn
 * funnel, and only then: with no body capability the funnel sends as it
 * always did; with it, such a card becomes a body card once, the host is
 * told its kind, and the funnel sends nothing; a card whose kind is not
 * registered is handed nowhere; a card that already
 * is a body card is sent the intent its
 * funnel has just decided, once; and the reconnect pass's fire for a body
 * card asks the host for nothing and sends its body nothing. A parked
 * workspace's card is handed off from its own workspace's deck.
 * The intent a card was handed is kept while it is a body card, a card whose
 * body failed is asked for again with the intent the shell gives it, and a
 * bound card's arrival waits on its body's ready, or its failure. A card the
 * shell defers stands `unmade` with no page asked for, keeps the latest intent
 * and its first state, and is asked for once, with them, when released; a
 * card whose page is already attached — kept across a shell reload — is
 * never deferred.
 *
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/body/body-intent.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BodyIntent } from "../../body/body-intent";
import type { TugConnection } from "../../connection";
import type { IDeckManagerStore } from "../../deck-manager-store";
import { BodyCardsStore, bodyCardsStore, bodyReadyQuiet } from "../body-cards-store";
import {
  _resetHandOffForTest,
  _setHostCapabilitiesForTest,
  askForBodyAgain,
  bodyIntentOf,
  forgetBodyIntent,
  handOffToBody,
  intentToAskAgain,
  isBodyKind,
  isDeferredBody,
  isMountBodyKind,
  releaseDeferredBody,
  setBodyDeferral,
} from "../body-handoff";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import { sessionIntent } from "../../bus/declarations/verbs";
import { registerShellDeck } from "../deck-store-registry";
import { registerCard } from "../../card-registry";
import {
  drainOpeningCommand,
  fireFreshSpawn,
  fireNewSpawn,
  fireRestore,
  restoreSessions,
  sessionRestoreRegistry,
  stashOpeningCommand,
} from "../session-restore";
import { publishListCardBindingsOk } from "../session-ledger-events";

let bus: TestBus | null = null;

/** A shell on the test bus, and the intents `cardId`'s body is sent (`session.intent`). */
async function bodyHearing(cardId: string): Promise<Array<{ cardId: string; intent: unknown }>> {
  bus = createTestBus();
  bus.install(bus.shell());
  const page = bus.body(cardId, "handoff-spawn");
  const heard: Array<{ cardId: string; intent: unknown }> = [];
  sessionIntent.on(page.bus).handle((intent) => heard.push({ cardId, intent }));
  await bus.flush();
  return heard;
}

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

// Two kinds of this file's own, so nothing here depends on, or disturbs,
// another file's registration of a real kind: one handed off at its spawn
// funnel as the Session card is, one the shell hands off itself.
registerCard({
  componentId: "handoff-spawn",
  contentFactory: () => null,
  defaultMeta: { title: "Spawn", closable: true },
  bodyHandOff: "spawn",
});
registerCard({
  componentId: "handoff-mount",
  contentFactory: () => null,
  defaultMeta: { title: "Mount", closable: true },
});
registerCard({
  componentId: "handoff-guarded",
  contentFactory: () => null,
  defaultMeta: { title: "Guarded", closable: true },
  guardsClose: true,
});

/** The state the shell holds per card; empty unless a test seeds it. */
const cardStates = new Map<string, Record<string, unknown>>();

const live = {
  cards: [
    { id: "s1", componentId: "handoff-spawn" },
    { id: "s2", componentId: "handoff-spawn" },
    { id: "g1", componentId: "git" },
    { id: "m1", componentId: "handoff-mount" },
    { id: "k1", componentId: "handoff-guarded" },
  ],
};
/** A parked workspace's deck, holding one card the live deck does not. */
const parked = { cards: [{ id: "pm1", componentId: "handoff-mount" }] };

const deck = {
  getSnapshot: () => live,
  spaceOf: (cardId: string) => (parked.cards.some((c) => c.id === cardId) ? "parked" : "live"),
  getSpaceDeck: (spaceId: string) => (spaceId === "parked" ? parked : live),
  getCardState: (cardId: string) => cardStates.get(cardId),
} as unknown as IDeckManagerStore;

const g = globalThis as { webkit?: unknown };
let priorWebkit: unknown;

beforeEach(() => {
  controlActions = [];
  posted = [];
  priorWebkit = g.webkit;
  const handler = (name: string) => ({
    postMessage: (body: unknown) => posted.push({ name, body: JSON.parse(body as string) }),
  });
  g.webkit = { messageHandlers: { bodyCreate: handler("bodyCreate") } };
  registerShellDeck(deck);
  _resetHandOffForTest();
});

afterEach(() => {
  cardStates.clear();
  for (const id of ["s1", "s2", "g1", "m1"]) sessionRestoreRegistry._clear(id);
  g.webkit = priorWebkit;
  registerShellDeck(null);
  bus?.dispose();
  bus = null;
  _setHostCapabilitiesForTest({ bodyViews: false });
  _resetHandOffForTest();
});

describe("without the capability", () => {
  test("nothing is handed off and the funnel sends as before", () => {
    _setHostCapabilitiesForTest({ bodyViews: false });
    fireRestore("s1", "tug-1", "/p", connection, "launch");
    expect(controlActions).toEqual(["spawn_session"]);
    expect(posted).toEqual([]);
    expect(bodyCardsStore.has("s1")).toBe(false);
  });

  test("no kind is a body kind", () => {
    _setHostCapabilitiesForTest({ bodyViews: false });
    expect(isBodyKind("handoff-spawn")).toBe(false);
    expect(isMountBodyKind("handoff-mount")).toBe(false);
  });
});

describe("with the capability", () => {
  beforeEach(() => {
    _setHostCapabilitiesForTest({ bodyViews: true });
  });

  test("a spawn kind's card is handed off once, with its kind and the funnel's intent", () => {
    fireRestore("s1", "tug-1", "/p", connection, "launch");
    expect(controlActions).toEqual([]);
    expect(posted).toEqual([
      {
        name: "bodyCreate",
        body: {
          cardId: "s1",
          componentId: "handoff-spawn",
          intent: { kind: "resume", tugSessionId: "tug-1", projectDir: "/p", reason: "launch" },
        },
      },
    ]);
    expect(bodyCardsStore.stateOf("s1")).toBe("creating");
  });

  test("every registered kind is a body kind; only one without a spawn hand-off is the shell's to hand off", () => {
    expect(isBodyKind("handoff-spawn")).toBe(true);
    expect(isBodyKind("handoff-mount")).toBe(true);
    expect(isBodyKind("git")).toBe(false);
    expect(isMountBodyKind("handoff-mount")).toBe(true);
    expect(isMountBodyKind("handoff-spawn")).toBe(false);
    expect(isMountBodyKind("git")).toBe(false);
  });

  test("a mount kind's card is handed off with a mount intent and its kind", () => {
    expect(handOffToBody("m1", () => ({ kind: "mount" }))).toBe(true);
    expect(posted).toEqual([
      { name: "bodyCreate", body: { cardId: "m1", componentId: "handoff-mount", intent: { kind: "mount" } } },
    ]);
    expect(bodyIntentOf("m1")).toEqual({ kind: "mount" });
  });

  test("a parked workspace's card is handed off from its own deck", () => {
    expect(handOffToBody("pm1", () => ({ kind: "mount" }))).toBe(true);
    expect(posted).toEqual([
      { name: "bodyCreate", body: { cardId: "pm1", componentId: "handoff-mount", intent: { kind: "mount" } } },
    ]);
  });

  test("a card's first hand-off carries the state the shell holds for it, whatever its intent", () => {
    const bag = { content: { draft: { text: "seeded" } } };
    cardStates.set("s1", bag);
    fireRestore("s1", "tug-1", "/p", connection, "launch");
    const sent = (posted[0]?.body as { intent: BodyIntent } | undefined)?.intent;
    expect(sent?.kind).toBe("resume");
    expect(sent?.bag).toEqual(bag);
  });

  test("a fresh spawn carries its stashed opening command into the intent", () => {
    stashOpeningCommand("s1", { name: "arc", args: "go" });
    fireFreshSpawn("s1", "tug-1", "/p", connection, "launch");
    expect(controlActions).toEqual([]);
    expect(posted[0]?.body).toEqual({
      cardId: "s1",
      componentId: "handoff-spawn",
      intent: {
        kind: "fresh",
        tugSessionId: "tug-1",
        projectDir: "/p",
        reason: "launch",
        openingCommand: { name: "arc", args: "go" },
      },
    });
    expect(drainOpeningCommand("s1")).toBeUndefined();
  });

  test("a new spawn carries the line and tag the shell minted", () => {
    fireNewSpawn("s2", "tug-2", "/p", connection, "restore-open", { lineId: "line-2", tag: "odd-kiln" });
    expect(controlActions).toEqual([]);
    expect(posted[0]?.body).toEqual({
      cardId: "s2",
      componentId: "handoff-spawn",
      intent: {
        kind: "new",
        tugSessionId: "tug-2",
        projectDir: "/p",
        reason: "restore-open",
        lineId: "line-2",
        tag: "odd-kiln",
      },
    });
  });

  test("a card whose kind is not a body kind is never handed off", () => {
    fireRestore("g1", "tug-3", "/p", connection, "launch");
    expect(controlActions).toEqual(["spawn_session"]);
    expect(posted).toEqual([]);
  });

  test("a card already a body card is sent the intent its funnel just decided, once", async () => {
    const forwarded = await bodyHearing("s1");
    fireRestore("s1", "tug-1", "/p", connection, "launch");
    posted = [];
    fireNewSpawn("s1", "tug-2", "/p", connection, "restore-open", { lineId: "line-2", tag: "odd-kiln" });
    await bus?.flush();
    const intent: BodyIntent = {
      kind: "new",
      tugSessionId: "tug-2",
      projectDir: "/p",
      reason: "restore-open",
      lineId: "line-2",
      tag: "odd-kiln",
    };
    expect(forwarded).toEqual([{ cardId: "s1", intent }]);
    expect(posted).toEqual([]);
    expect(controlActions).toEqual([]);
    // A body that fails later re-runs the latest decision, not the first.
    expect(bodyIntentOf("s1")).toEqual(intent);
  });

  test("the reconnect pass's fire for a body card posts nothing and sends its body nothing", async () => {
    const forwarded = await bodyHearing("s1");
    fireRestore("s1", "tug-1", "/p", connection, "launch");
    posted = [];
    restoreSessions(deck, connection, { reason: "server-restart", reassert: true, cardIds: new Set(["s1"]) });
    publishListCardBindingsOk({
      bindings: [{ card_id: "s1", session_id: "tug-1", project_dir: "/p", turn_count: 2, state: "live" }],
    });
    await bus?.flush();
    expect(posted).toEqual([]);
    expect(forwarded).toEqual([]);
    expect(controlActions).toEqual(["list_card_bindings"]);
  });

  test("the intent a card was handed is kept until the card is no longer a body card", () => {
    fireNewSpawn("s2", "tug-2", "/p", connection, "restore-open", { lineId: "line-2", tag: "odd-kiln" });
    expect(bodyIntentOf("s2")).toEqual({
      kind: "new",
      tugSessionId: "tug-2",
      projectDir: "/p",
      reason: "restore-open",
      lineId: "line-2",
      tag: "odd-kiln",
    });
    forgetBodyIntent("s2");
    expect(bodyIntentOf("s2")).toBeNull();
  });

  test("a card whose body failed is asked for again, with the intent the shell gives it", () => {
    fireNewSpawn("s2", "tug-2", "/p", connection, "restore-open", { lineId: "line-2", tag: "odd-kiln" });
    bodyCardsStore.setState("s2", "failed");
    posted = [];
    askForBodyAgain("s2", { kind: "restore" });
    expect(posted).toEqual([
      { name: "bodyCreate", body: { cardId: "s2", componentId: "handoff-spawn", intent: { kind: "restore" } } },
    ]);
    expect(bodyCardsStore.stateOf("s2")).toBe("creating");
    expect(bodyIntentOf("s2")).toEqual({ kind: "restore" });
    expect(controlActions).toEqual([]);
  });

  test("a failed body is asked for again to restore a session the shell holds, never to start a second", () => {
    const fresh: BodyIntent = { kind: "new", tugSessionId: "t1", projectDir: "/p" } as unknown as BodyIntent;
    expect(intentToAskAgain(fresh, false, true), "the gone body's spawn was acknowledged").toEqual({ kind: "restore" });
    expect(intentToAskAgain(fresh, false, false), "no binding yet: the spawn runs again").toBe(fresh);
    expect(intentToAskAgain(null, false, false)).toEqual({ kind: "restore" });
    expect(intentToAskAgain(fresh, true, true), "a kind the shell hands off itself mounts").toEqual({ kind: "mount" });
    const bind = { kind: "bind" } as unknown as BodyIntent;
    expect(intentToAskAgain(bind, false, true), "the harness's bind is handed again").toBe(bind);
  });

  test("a card that is not a body card is not asked for again", () => {
    askForBodyAgain("s2", { kind: "restore" });
    expect(posted).toEqual([]);
  });

  test("a deferred card gets no page until released, then one, with its latest intent and first state", () => {
    setBodyDeferral((cardId) => cardId === "m1");
    cardStates.set("m1", { scroll: 7 });
    expect(handOffToBody("m1", () => ({ kind: "mount" }))).toBe(true);
    expect(posted).toEqual([]);
    expect(bodyCardsStore.stateOf("m1")).toBe("unmade");
    expect(isDeferredBody("m1")).toBe(true);

    // A funnel deciding again while it waits changes what it will be handed, and asks for nothing.
    expect(handOffToBody("m1", () => ({ kind: "restore" }))).toBe(true);
    expect(posted).toEqual([]);

    expect(releaseDeferredBody("m1")).toBe(true);
    expect(posted).toEqual([
      {
        name: "bodyCreate",
        body: { cardId: "m1", componentId: "handoff-mount", intent: { kind: "restore", bag: { scroll: 7 } } },
      },
    ]);
    expect(bodyCardsStore.stateOf("m1")).toBe("creating");
    expect(isDeferredBody("m1")).toBe(false);
    expect(releaseDeferredBody("m1"), "released once").toBe(false);

    // A card the deferral does not name is asked for at once, as before.
    expect(handOffToBody("s1", () => ({ kind: "restore" }))).toBe(true);
    expect(posted).toHaveLength(2);

    // Nor is one whose kind may veto its close, whatever the deferral says.
    setBodyDeferral(() => true);
    expect(handOffToBody("k1", () => ({ kind: "mount" }))).toBe(true);
    expect(posted).toHaveLength(3);
    expect(isDeferredBody("k1")).toBe(false);
  });

  test("a kept body across a shell reload is never deferred: its page is attached, so the host is asked for it", async () => {
    // The host kept m1's page across the shell's reload; it has said hello
    // to this shell before the shell hands the card off.
    bus = createTestBus();
    bus.install(bus.shell());
    bus.body("m1", "handoff-mount");
    await bus.flush();

    // An inactive tab: the deferral would hold any other card back.
    setBodyDeferral(() => true);
    expect(handOffToBody("m1", () => ({ kind: "mount" }))).toBe(true);
    expect(posted).toEqual([{ name: "bodyCreate", body: { cardId: "m1", componentId: "handoff-mount", intent: { kind: "mount" } } }]);
    expect(bodyCardsStore.stateOf("m1"), "not unmade, so its kept page's reports are read").toBe("creating");
    expect(isDeferredBody("m1")).toBe(false);

    // A card with no attached page is still deferred.
    expect(handOffToBody("s1", () => ({ kind: "restore" }))).toBe(true);
    expect(bodyCardsStore.stateOf("s1")).toBe("unmade");
    expect(posted).toHaveLength(1);
  });
});

describe("bodyReadyQuiet", () => {
  test("is quiet when the body has painted, not at ready, and when it failed and the card was taken back", () => {
    const store = new BodyCardsStore();
    const quiet = bodyReadyQuiet("c1", store);
    let fires = 0;
    const release = quiet.subscribe(() => fires++);
    expect(quiet.isQuiet()).toBe(false);
    store.mark("c1");
    expect(quiet.isQuiet()).toBe(false);
    store.setState("c1", "ready");
    expect(quiet.isQuiet(), "ready is not yet a frame to carry in").toBe(false);
    store.setState("c1", "painted");
    expect(quiet.isQuiet()).toBe(true);
    expect(fires).toBe(3);

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
