/**
 * The two questions the shell asks a card's body, as exchanges between a
 * shell page and a body page on the test bus.
 *
 * A close decision asks the card's own close guard. A guard that said it
 * would not ask answers at once, so the shell waits on it only to its
 * deadline and then cancels the close; a guard that asks waits on the person
 * at its sheet with no deadline at all; the card's page going away cancels
 * it. A question for a Session card is shown in the body's dialog, stands
 * across a reload of the page, and its caller hears the choice once; a
 * question the shell takes back takes the dialog down.
 *
 * @covers tugdeck/src/lib/close-decision.ts
 * @covers tugdeck/src/lib/pending-ask-store.ts
 * @covers tugdeck/src/body/body-verbs.ts
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { answerBodyVerbs } from "../body-verbs";
import { createTestBus, type TestBus, type TestPage } from "../../bus/test-bus";
import { registerCardCloseGuard } from "../../lib/card-close-guard";
import { cardServicesStore, type CardServices } from "../../lib/card-services-store";
import { askCloseDecision } from "../../lib/close-decision";
import type { PendingAsk } from "../../lib/code-session-store/types";
import { pendingAskStore, showAskInBody } from "../../lib/pending-ask-store";

let bus: TestBus;
const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  bus?.dispose();
});

/** A shell, installed as this page's bus, and card `cardId`'s body answering the shell's verbs. */
async function shellAndBody(cardId: string): Promise<TestPage> {
  bus = createTestBus();
  bus.install(bus.shell());
  const body = answeringBody(cardId);
  await bus.flush();
  return body;
}

function answeringBody(cardId: string): TestPage {
  const body = bus.body(cardId, "session");
  releases.push(answerBodyVerbs(body.bus, { cardId, componentId: "session", replayIntent: () => {} }));
  return body;
}

/** Wait `ms` of real time: the deadline under test is a real timer. */
const elapse = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("a close decision", () => {
  test("answers cancel at its deadline when the guard said it would not ask and the body is silent", async () => {
    bus = createTestBus();
    bus.install(bus.shell());
    bus.body("C", "text");
    await bus.flush();
    expect(await askCloseDecision("C", false, 20)).toBe("cancel");
  });

  test("waits on the person at the sheet with no deadline, and takes their answer", async () => {
    await shellAndBody("C");
    let answer!: (a: "close" | "cancel") => void;
    releases.push(
      registerCardCloseGuard("C", {
        needsDecision: () => true,
        run: () => new Promise((resolve) => (answer = resolve)),
      }),
    );
    let decided = null as string | null;
    void askCloseDecision("C", true, 20).then((d) => (decided = d));
    await bus.flush();
    await elapse(60);
    expect(decided).toBeNull();
    answer("close");
    await elapse(0);
    await bus.flush();
    await elapse(0);
    expect(decided).toBe("close");
  });

  test("is cancelled when the card's page goes away under it", async () => {
    await shellAndBody("C");
    releases.push(registerCardCloseGuard("C", { needsDecision: () => true, run: () => new Promise(() => {}) }));
    const decided = askCloseDecision("C", true);
    await bus.flush();
    bus.detach("C");
    await bus.flush();
    expect(await decided).toBe("cancel");
  });
});

describe("a question for a Session card", () => {
  const ASK = { requestId: "q1", title: "Proceed?", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] };

  /** The shell's store, holding `S`'s session in its body; what it answers callers on the wire. */
  function shellStore(): Array<{ action: string; payload: Record<string, unknown> }> {
    const wire: Array<{ action: string; payload: Record<string, unknown> }> = [];
    releases.push(
      pendingAskStore.init({
        sendControlFrame: (action, payload) => wire.push({ action, payload }),
        focusedTugSessionId: () => null,
        sessionFor: (id) => (id === "sess" ? { tugSessionId: "sess", setPendingAsk: (ask) => showAskInBody("S", ask) } : null),
        observeSessions: () => () => {},
      }),
    );
    return wire;
  }

  /** The body's session, as `S`'s page holds it: what it was asked to show. */
  function bodySession(): Array<PendingAsk | null> {
    const parked: Array<PendingAsk | null> = [];
    const services = { codeSessionStore: { setPendingAsk: (ask: PendingAsk | null) => parked.push(ask) } };
    const spy = spyOn(cardServicesStore, "getServices").mockImplementation((cardId) =>
      cardId === "S" ? (services as unknown as CardServices) : null,
    );
    releases.push(() => spy.mockRestore());
    return parked;
  }

  /** A press in the body's dialog: the answer the body's page last relayed for the question. */
  function dialogPress(): (choice: string) => void {
    const spy = spyOn(pendingAskStore, "relay");
    releases.push(() => spy.mockRestore());
    return (choice) => {
      const calls = spy.mock.calls;
      calls[calls.length - 1][1](choice);
    };
  }

  test("stands across a reload of the card's page and is answered once", async () => {
    const parked = bodySession();
    const press = dialogPress();
    await shellAndBody("S");
    const wire = shellStore();

    pendingAskStore.receive({ ...ASK, sessionId: "sess" });
    await bus.flush();
    expect(parked.map((a) => a?.requestId)).toEqual(["q1"]);

    // The page reloads: the new one is shown the same question.
    bus.detach("S");
    answeringBody("S");
    await bus.flush();
    expect(parked.map((a) => a?.requestId ?? null)).toEqual(["q1", "q1"]);
    expect(wire).toEqual([]);

    press("yes");
    await bus.flush();
    await elapse(0);
    expect(wire).toEqual([{ action: "ask-response", payload: { requestId: "q1", choice: "yes" } }]);
  });

  test("taken back by the shell, takes the dialog down", async () => {
    const parked = bodySession();
    await shellAndBody("S");
    const wire = shellStore();

    pendingAskStore.receive({ ...ASK, requestId: "q2", sessionId: "sess" });
    await bus.flush();
    pendingAskStore.rescind("q2");
    await bus.flush();
    expect(parked.map((a) => a?.requestId ?? null)).toEqual(["q2", null]);
    expect(wire).toEqual([]);
  });
});
