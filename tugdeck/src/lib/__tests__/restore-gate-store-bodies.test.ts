/**
 * The restore gate holds for a body card's cold restore, which its body
 * reports, and counts the sessions it is restoring.
 *
 * A body Session card's session store is in its own page, so the shell's
 * services store has none for it. Its body sets the card's restore in its
 * `card.restoreHold` (`readRestoreHold`, `body-publisher.ts`): `"holding"`
 * while `deriveRestoreGateHold` holds it — the replay window and the reveal
 * behind it — `"waiting"` while its restore is still to come, and null
 * otherwise, including when the card's own silence deadline errors it. The
 * shell's gate folds those replicas: open while any body card says it is
 * holding, counting sessions over a total fixed when the round opens (the
 * holders and the cards a restore pass named); closed when they stop, when
 * a page is terminated (the store clears on detach), and for a card that is
 * not a body card. Each body is a page of the test bus, and the shell's is
 * this page's bus.
 *
 * @covers tugdeck/src/lib/restore-gate-store.ts
 * @covers tugdeck/src/lib/body-facts-store.ts
 * @covers tugdeck/src/body/body-publisher.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cardFacts, cardRestoreHold, type CardFactsValue } from "../../bus/declarations/card";
import { createTestBus, type TestBus, type TestPage } from "../../bus/test-bus";
import { restoreGateStore } from "../restore-gate-store";
import { restoreGateRoster } from "../restore-gate-roster";
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

let bus: TestBus;
afterEach(() => {
  bus?.dispose();
  bodyCardsStore._reset();
  // The cases reuse card ids, and the gate's round would otherwise carry a
  // pending member from one case into the next.
  restoreGateRoster.take();
  restoreGateStore._resetForTest();
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
  test("two bodies a pass named holding open a round of two; the first letting go reads 1 of 2; both letting go closes", async () => {
    const { a, b } = await pages("a", "b");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    // Each body's report reaches the shell on its own delivery, so the
    // round opens on the first; the pass's names are what make it two.
    restoreGateRoster.expect(["a", "b"]);
    expect(restoreGateStore.getSnapshot().open).toBe(false);

    cardRestoreHold.on(a.bus).set("holding");
    cardRestoreHold.on(b.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 2 });

    cardRestoreHold.on(a.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 1, sessionsTotal: 2 });

    cardRestoreHold.on(b.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);
  });

  test("a pass naming three body cards and one holding opens a round of three", async () => {
    const { a, b, c } = await pages("a", "b", "c");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    bodyCardsStore.mark("c");
    cardRestoreHold.on(b.bus).set("waiting");
    cardRestoreHold.on(c.bus).set("waiting");
    await bus.flush();
    restoreGateRoster.expect(["a", "b", "c"]);
    expect(restoreGateStore.getSnapshot().open).toBe(false);

    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 3 });
  });

  test("a body reporting waiting does not open the gate", async () => {
    const { a } = await pages("a");
    bodyCardsStore.mark("a");
    cardRestoreHold.on(a.bus).set("waiting");
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
    cardRestoreHold.on(a.bus).set("holding");
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
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);

    bus.detach("a");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    expect(bodyFactsStore.canInterrupt("a")).toBe(true);
  });

  test("a card that is no body card is not held, and a destroyed one lets go", async () => {
    const { a, stray } = await pages("a", "stray");
    cardRestoreHold.on(stray.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);

    bodyCardsStore.mark("a");
    cardRestoreHold.on(a.bus).set("holding");
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

  test("the replay window and the reveal behind it hold", () => {
    expect(readRestoreHold(snapshot({ phase: "replaying" }), false)).toBe("holding");
    expect(readRestoreHold(snapshot({ replayPreflightActive: true }), false)).toBe("holding");
    expect(readRestoreHold(snapshot({ replayEverCompleted: true }), false)).toBe("holding");
  });

  test("a restore still to come waits: in the registry, or a resume whose replay has not begun", () => {
    expect(readRestoreHold(null, true)).toBe("waiting");
    expect(readRestoreHold(snapshot({ replayEverCompleted: true, coldRevealSettled: true }), true)).toBe("waiting");
    // Between the registry clearing and the preflight opening.
    expect(readRestoreHold(snapshot({}), false)).toBe("waiting");
  });

  test("nothing outside a restore, after the reveal settles, once the card errors (the silence deadline), or for a fresh session", () => {
    expect(readRestoreHold(null, false)).toBeNull();
    expect(readRestoreHold(snapshot({ replayEverCompleted: true, coldRevealSettled: true }), false)).toBeNull();
    expect(readRestoreHold(snapshot({ phase: "replaying", lastError: { cause: "replay_stalled" } as never }), false)).toBeNull();
    expect(readRestoreHold(snapshot({ lastError: { cause: "replay_stalled" } as never }), true)).toBeNull();
    expect(readRestoreHold(snapshot({ phase: "replaying", sessionMode: "new" }), false)).toBeNull();
  });
});
