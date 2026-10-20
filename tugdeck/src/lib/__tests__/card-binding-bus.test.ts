/**
 * A body card's session binding, held with the shell (`card.binding`).
 *
 * A body binds, resumes and rebinds in its own page, from acks the shell's
 * connection never hears, and the shell reads the binding all the same. So
 * the shell owns it and the body proposes each change of its own card's
 * binding. Each page holds its own `CardSessionBindingStore`, shared through
 * `shareCardBinding` on the test bus.
 *
 * Nothing about a card's masthead reaches the binding any more, so a rebind's
 * masthead gap cannot clear the shell's binding: what the shell holds moves
 * only on the body's own word.
 *
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 * @covers tugdeck/src/bus/declarations/relays.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import { CardSessionBindingStore, shareCardBinding, type CardSessionBinding } from "../card-session-binding-store";
import { createTestBus, type TestBus, type TestPage } from "../../bus/test-bus";
import { cardBinding } from "../../bus/declarations/relays";
import { deckCards, type DeckCardFacts } from "../../bus/declarations/deck";

const X: CardSessionBinding = { tugSessionId: "seg-x", lineId: "line", workspaceKey: "wk", projectDir: "/p", sessionMode: "resume" };
const Y: CardSessionBinding = { ...X, tugSessionId: "seg-y" };

let bus: TestBus;
afterEach(() => bus?.dispose());

interface Shared {
  page: TestPage;
  store: CardSessionBindingStore;
}

function share(page: TestPage): Shared {
  const store = new CardSessionBindingStore();
  shareCardBinding(page.bus, store);
  return { page, store };
}

/** A card's `deck.cards` record carrying only its binding. */
const recordOf = (binding: CardSessionBinding): DeckCardFacts => ({
  componentId: "session",
  title: null,
  masthead: null,
  identity: null,
  activity: null,
  binding,
  parkedTitle: null,
  waivesClose: false,
});

/** The shell, projecting every binding to `deck.cards` as `body-shell.ts` does. */
function shellPage(): Shared & { history: Array<string | null> } {
  const shell = share(bus.shell());
  const history: Array<string | null> = [];
  shell.store.subscribe(() => {
    history.push(shell.store.getBinding("A")?.tugSessionId ?? null);
    deckCards.on(shell.page.bus).set(
      Object.fromEntries([...shell.store.getSnapshot()].map(([id, binding]) => [id, recordOf(binding)])),
    );
  });
  return { ...shell, history };
}

const proposals = (): number =>
  bus.frames().filter((f) => (f.envelope as { key?: string }).key === "card.binding" && f.envelope.kind === "action").length;

describe("a body card's binding", () => {
  test("proposed in its body, is the shell's, and every other body reads it", async () => {
    bus = createTestBus();
    const shell = shellPage();
    const a = share(bus.body("A", "session"));
    const b = bus.body("B", "session");
    await bus.flush();

    a.store.setBinding("A", X);
    // Optimistic: the body's own replica says it at once.
    expect(cardBinding.on(a.page.bus).getSnapshot()).toEqual(X);
    await bus.flush();
    expect(shell.store.getBinding("A")).toEqual(X);
    expect(cardBinding.on(shell.page.bus).getFor("A")).toEqual(X);
    expect(deckCards.on(b.bus).getSnapshot()).toEqual({ A: recordOf(X) });
  });

  test("a resume onto another segment moves the shell's binding with no gap", async () => {
    bus = createTestBus();
    const shell = shellPage();
    const a = share(bus.body("A", "session"));
    await bus.flush();
    a.store.setBinding("A", X);
    await bus.flush();

    a.store.setSeatedSegment("A", "seg-z", "line");
    a.store.setBinding("A", Y);
    await bus.flush();
    expect(shell.store.getBinding("A")?.tugSessionId).toBe("seg-y");
    expect(shell.history.includes(null)).toBe(false);
  });

  test("a body that has bound nothing says nothing, so its reload leaves the shell's binding standing", async () => {
    bus = createTestBus();
    const shell = shellPage();
    const first = share(bus.body("A", "session"));
    await bus.flush();
    first.store.setBinding("A", X);
    await bus.flush();
    const before = proposals();

    // The page reloads under the same card: a new page, a store with nothing in it yet.
    bus.leave(first.page);
    bus.detach("A");
    const reloaded = share(bus.body("A", "session"));
    await bus.flush();
    expect(proposals()).toBe(before);
    expect(shell.store.getBinding("A")).toEqual(X);
    expect(reloaded.store.getBinding("A")).toBeUndefined();

    // Once it binds, it says so.
    reloaded.store.setBinding("A", Y);
    await bus.flush();
    expect(shell.store.getBinding("A")).toEqual(Y);
  });

  test("a card that lets its session go takes the shell's binding with it", async () => {
    bus = createTestBus();
    const shell = shellPage();
    const a = share(bus.body("A", "session"));
    await bus.flush();
    a.store.setBinding("A", X);
    await bus.flush();
    a.store.clearBinding("A");
    await bus.flush();
    expect(shell.store.getBinding("A")).toBeUndefined();
    expect(cardBinding.on(shell.page.bus).getFor("A")).toBeNull();
  });

  test("other cards' bindings mirrored into a body are never proposed", async () => {
    bus = createTestBus();
    shellPage();
    const a = share(bus.body("A", "session"));
    await bus.flush();
    a.store.setBinding("B", X);
    a.store.clearBinding("B");
    await bus.flush();
    expect(proposals()).toBe(0);
  });
});
