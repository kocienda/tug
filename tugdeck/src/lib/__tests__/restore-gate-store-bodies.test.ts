/**
 * The restore gate holds for a body card's cold restore, which its body
 * reports.
 *
 * A body Session card's session store is in its own page, so the shell's
 * services store has none for it. Its body sets the card's restore in its
 * `card.restoreHold` (`readRestoreHold`, `body-publisher.ts`) while
 * `deriveRestoreGateHold` holds it — the replay window and the reveal behind
 * it — and null once it lets go, including when the card's own silence
 * deadline errors it. The shell's gate folds those replicas: open while any
 * body card says it is restoring, with its turns summed; closed when it
 * stops saying so, when its page is terminated (the store clears on
 * detach), and for a card that is not a body card. Each body is a page of
 * the test bus, and the shell's is this page's bus.
 *
 * @covers tugdeck/src/lib/restore-gate-store.ts
 * @covers tugdeck/src/lib/body-facts-store.ts
 * @covers tugdeck/src/body/body-publisher.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cardFacts, cardRestoreHold, type CardFactsValue } from "../../bus/declarations/card";
import { createTestBus, type TestBus, type TestPage } from "../../bus/test-bus";
import { restoreGateStore } from "../restore-gate-store";
import { bodyCardsStore } from "../body-cards-store";
import { bodyFactsStore } from "../body-facts-store";
import { readRestoreHold } from "../../body/body-publisher";
import type { CodeSessionSnapshot } from "../code-session-store";

const FACTS: CardFactsValue = {
  title: "Session",
  masthead: null,
  activity: "idle",
  identity: null,
  titleBar: null,
  canInterrupt: false,
  compacted: false,
  dormant: false,
};

const HOLD = { turnsLoaded: 3, turnsTarget: 10 };

let bus: TestBus;
afterEach(() => {
  bus?.dispose();
  bodyCardsStore._reset();
});

/** The shell, installed as this page's bus, and a body page for each card. */
async function pages(...cards: string[]): Promise<Record<string, TestPage>> {
  bus = createTestBus();
  bus.install(bus.shell());
  const out: Record<string, TestPage> = {};
  for (const cardId of cards) out[cardId] = bus.body(cardId, "session");
  await bus.flush();
  return out;
}

describe("the shell's gate over body cards", () => {
  test("opens for a body card its body says is restoring, and sums the turns", async () => {
    const { a, b } = await pages("a", "b");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    expect(restoreGateStore.getSnapshot().open).toBe(false);

    cardRestoreHold.on(a.bus).set(HOLD);
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, cards: 1, turnsLoaded: 3, turnsTarget: 10 });

    cardRestoreHold.on(b.bus).set({ turnsLoaded: 1, turnsTarget: 5 });
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, cards: 2, turnsLoaded: 4, turnsTarget: 15 });

    cardRestoreHold.on(a.bus).set(null);
    cardRestoreHold.on(b.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);
  });

  test("notifies its readers when a body's report moves it", async () => {
    const { a } = await pages("a");
    bodyCardsStore.mark("a");
    let notified = 0;
    const release = restoreGateStore.subscribe(() => {
      notified += 1;
    });
    cardRestoreHold.on(a.bus).set(HOLD);
    await bus.flush();
    cardRestoreHold.on(a.bus).set(null);
    await bus.flush();
    release();
    expect(notified).toBe(2);
  });

  test("the hold goes with the page: a termination ends it, the card's other facts stand", async () => {
    const { a } = await pages("a");
    bodyCardsStore.mark("a");
    cardFacts.on(a.bus).set({ ...FACTS, canInterrupt: true });
    cardRestoreHold.on(a.bus).set(HOLD);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);

    bus.detach("a");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    expect(bodyFactsStore.canInterrupt("a")).toBe(true);
  });

  test("a card that is no body card is not held, and a destroyed one lets go", async () => {
    const { a, stray } = await pages("a", "stray");
    cardRestoreHold.on(stray.bus).set(HOLD);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);

    bodyCardsStore.mark("a");
    cardRestoreHold.on(a.bus).set(HOLD);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);
    bodyCardsStore.drop("a");
    expect(restoreGateStore.getSnapshot().open).toBe(false);
  });
});

describe("what a body reports", () => {
  const snapshot = (over: Partial<CodeSessionSnapshot>): CodeSessionSnapshot =>
    ({
      phase: "idle",
      sessionMode: "resume",
      replayPreflightActive: false,
      lastError: null,
      replayEverCompleted: false,
      coldRevealSettled: false,
      transcript: [{}, {}],
      restoreWindowTurns: 10,
      ...over,
    }) as unknown as CodeSessionSnapshot;

  test("the replay window and the reveal behind it hold, with the turns", () => {
    expect(readRestoreHold(snapshot({ phase: "replaying" }))).toEqual({ turnsLoaded: 2, turnsTarget: 10 });
    expect(readRestoreHold(snapshot({ replayPreflightActive: true }))).not.toBeNull();
    expect(readRestoreHold(snapshot({ replayEverCompleted: true }))).not.toBeNull();
  });

  test("nothing outside a restore, after the reveal settles, or once the card errors (the silence deadline)", () => {
    expect(readRestoreHold(null)).toBeNull();
    expect(readRestoreHold(snapshot({}))).toBeNull();
    expect(readRestoreHold(snapshot({ replayEverCompleted: true, coldRevealSettled: true }))).toBeNull();
    expect(readRestoreHold(snapshot({ phase: "replaying", lastError: { cause: "replay_stalled" } as never }))).toBeNull();
    expect(readRestoreHold(snapshot({ phase: "replaying", sessionMode: "new" }))).toBeNull();
  });
});
