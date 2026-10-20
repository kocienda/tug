/**
 * The verbs the shell asks of a card's body, as exchanges between a shell
 * page and a body page on the test bus.
 *
 * Each is sent from the shell to the card and answered in its body
 * (`answerBodyVerbs`). One sent before the card's page has said hello is
 * held and delivered once it does, so the shell keeps no queue of its own.
 *
 * @covers tugdeck/src/body/body-verbs.ts
 * @covers tugdeck/src/bus/declarations/verbs.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import { answerBodyVerbs } from "../body-verbs";
import type { BodyIntent } from "../body-intent";
import { focusEnter, focusExit, jotsNewJot, sessionIntent } from "../../bus/declarations/verbs";
import { createTestBus, type TestBus, type TestPage } from "../../bus/test-bus";
import { getJotsStore } from "../../lib/jots-store";

let bus: TestBus;
const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  bus?.dispose();
});

function body(cardId: string, componentId: string, replayed: BodyIntent[] = []): TestPage {
  const page = bus.body(cardId, componentId);
  releases.push(
    answerBodyVerbs(page.bus, {
      cardId,
      componentId,
      replayIntent: (intent) => replayed.push(intent),
    }),
  );
  return page;
}

describe("the shell's verbs, answered in the card's body", () => {
  test("⌘J's capture sent before the Jots body attaches opens its editor once it does", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const before = getJotsStore().getSnapshot().doc.jots.length;
    jotsNewJot.on(shell.bus).dispatch({}, { card: "J" });
    await bus.flush();
    expect(getJotsStore().getSnapshot().doc.jots.length).toBe(before);

    body("J", "jots");
    await bus.flush();
    const after = getJotsStore().getSnapshot();
    expect(after.doc.jots.length).toBe(before + 1);
    expect(after.editingId).toBe(after.doc.jots[after.doc.jots.length - 1].id);
  });

  test("a walk handed into a body with no stop goes back out, marked empty", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const exits: Array<{ direction: string; empty?: boolean; cardId: string | null }> = [];
    releases.push(focusExit.on(shell.bus).handle(({ direction, empty }, from) => exits.push({ direction, empty, cardId: from.cardId })));
    body("A", "session");
    await bus.flush();

    focusEnter.on(shell.bus).dispatch({ edge: "first" }, { card: "A" });
    focusEnter.on(shell.bus).dispatch({ edge: "last" }, { card: "A" });
    await bus.flush();
    expect(exits).toEqual([
      { direction: "next", empty: true, cardId: "A" },
      { direction: "previous", empty: true, cardId: "A" },
    ]);
  });

  test("a session decided after the hand-off is replayed in the body, and one that does not parse is not", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const replayed: BodyIntent[] = [];
    body("S", "session", replayed);
    await bus.flush();

    sessionIntent.on(shell.bus).dispatch({ kind: "restore" }, { card: "S" });
    sessionIntent.on(shell.bus).dispatch({ kind: "nonsense" }, { card: "S" });
    await bus.flush();
    expect(replayed).toEqual([{ kind: "restore" }]);
  });
});
