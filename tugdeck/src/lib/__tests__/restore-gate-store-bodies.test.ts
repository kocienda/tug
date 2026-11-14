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
import { GATE_FLOOR_MS, HOLD_HORIZON_MS } from "../restore-gate-store";
import { restoreGateRoster } from "../restore-gate-roster";
import { bodyCardsStore } from "../body-cards-store";
import { bodyFactsStore } from "../body-facts-store";
import { registerShellDeck } from "../deck-store-registry";
import { registerStubShellDeck } from "../../__tests__/shell-deck-stub";
import type { IDeckManagerStore } from "../../deck-manager-store";
import { readRestoreHold, restorePaintQuiet } from "../../body/body-publisher";
import type { CodeSessionSnapshot } from "../code-session-store";

const FACTS: CardFactsValue = {
  title: "Session",
  masthead: null,
  activity: "idle",
  identity: null,
  titleBar: null,
  canInterrupt: false,
  compacted: false,
  directories: [],
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
  registerShellDeck(null);
  clock = 0;
});

/** The clock the cases own, ms. */
let clock = 0;

/** Read every card at `ms` on the cases' clock; later folds read the same time until it moves. */
function at(ms: number): void {
  clock = ms;
  restoreGateStore._watchForTest(clock);
}

/**
 * Whether the gate is closed once its floor has run out. An opened gate stays
 * on screen for {@link GATE_FLOOR_MS} whoever lets go, so "nothing holds it"
 * is read past the floor: with a hold still standing it would be open there.
 */
function closedPastFloor(): boolean {
  at(clock + GATE_FLOOR_MS);
  return !restoreGateStore.getSnapshot().open;
}

/** The shell, installed as this page's bus, and a body page for each card. */
async function pages(...cards: string[]): Promise<Record<string, TestPage>> {
  bus = createTestBus();
  bus.install(bus.shell());
  const out: Record<string, TestPage> = {};
  for (const cardId of cards) out[cardId] = bus.body(cardId, "session");
  await bus.flush();
  // Every case runs on the clock it owns, from zero.
  at(0);
  return out;
}

describe("the shell's gate over body cards", () => {
  test("two bodies a pass named holding open a round of two; the first letting go reads 1 of 2; both letting go closes", async () => {
    const { a, b } = await pages("a", "b");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    // Each body's report reaches the shell on its own delivery, so the
    // pass's names are what make the round two — and what open it, before
    // either page has said a word.
    at(0);
    restoreGateRoster.expect(["a", "b"]);
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 2 });

    cardRestoreHold.on(a.bus).set("holding");
    cardRestoreHold.on(b.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 2 });

    cardRestoreHold.on(a.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 1, sessionsTotal: 2 });

    cardRestoreHold.on(b.bus).set(null);
    await bus.flush();
    // Inside the floor the gate stands, reading the round finished.
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 2, sessionsTotal: 2 });
    expect(closedPastFloor()).toBe(true);
  });

  test("a pass naming three body cards opens a round of three, whatever their pages have said", async () => {
    const { a, b, c } = await pages("a", "b", "c");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    bodyCardsStore.mark("c");
    // The pass names its cards before any of their pages exists.
    restoreGateRoster.expect(["a", "b", "c"]);
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 3 });

    cardRestoreHold.on(b.bus).set("waiting");
    cardRestoreHold.on(c.bus).set("waiting");
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 3 });
  });

  test("a body reporting waiting holds the gate as one holding does", async () => {
    const { a } = await pages("a");
    bodyCardsStore.mark("a");
    cardRestoreHold.on(a.bus).set("waiting");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 1 });
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 1 });
    cardRestoreHold.on(a.bus).set(null);
    await bus.flush();
    expect(closedPastFloor()).toBe(true);
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
    expect(closedPastFloor()).toBe(true);
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
    expect(closedPastFloor()).toBe(true);
  });
});

describe("who may hold the gate, and for how long", () => {
  /** A deck of two workspaces: `a` in `front`, `b` in `parked`; `show` moves the shown one. */
  function deckOf(spaces: Record<string, string>): { show(spaceId: string): void; followers(): number } {
    let activeSpaceId = "front";
    const listeners = new Set<() => void>();
    registerStubShellDeck({
      spaceOf: (cardId: string) => spaces[cardId] ?? null,
      getSpacesSnapshot: () => ({ activeSpaceId }),
      subscribeSpaces: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as IDeckManagerStore);
    return {
      show(spaceId) {
        activeSpaceId = spaceId;
        for (const listener of [...listeners]) listener();
      },
      followers: () => listeners.size,
    };
  }

  test("a card in a parked workspace does not hold; shown, it does", async () => {
    const deck = deckOf({ a: "front", b: "parked" });
    const { b } = await pages("a", "b");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    // A page made ahead, inside its resume replay.
    cardRestoreHold.on(b.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);

    deck.show("parked");
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 1 });
    deck.show("front");
    expect(closedPastFloor()).toBe(true);
  });

  test("a deck registered over another is the one followed, and the first is let go", async () => {
    const first = deckOf({ a: "front" });
    const { a } = await pages("a");
    bodyCardsStore.mark("a");
    restoreGateStore._watchForTest(0);
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);
    expect(first.followers()).toBe(1);

    // The registry is last-wins: the next fold reads the deck that stands now.
    const second = deckOf({ a: "parked" });
    restoreGateStore._watchForTest(GATE_FLOOR_MS);
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    expect(first.followers()).toBe(0);
    expect(second.followers()).toBe(1);
    second.show("parked");
    expect(restoreGateStore.getSnapshot().open).toBe(true);

    // With no deck registered there is no workspace to be parked in.
    second.show("front");
    restoreGateStore._watchForTest(2 * GATE_FLOOR_MS);
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    registerShellDeck(null);
    restoreGateStore._watchForTest(2 * GATE_FLOOR_MS + 1);
    expect(restoreGateStore.getSnapshot().open).toBe(true);
    expect(second.followers()).toBe(0);
  });

  test("a body that goes dormant on its hold lets go, and holds again awake", async () => {
    const { a } = await pages("a");
    bodyCardsStore.mark("a");
    cardFacts.on(a.bus).set(FACTS);
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);

    cardFacts.on(a.bus).set({ ...FACTS, dormant: true });
    await bus.flush();
    expect(closedPastFloor()).toBe(true);

    cardFacts.on(a.bus).set(FACTS);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);
  });

  test("an evicted card's last word does not hold", async () => {
    const { a } = await pages("a");
    bodyCardsStore.mark("a");
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);
    bodyCardsStore.setState("a", "evicted");
    expect(closedPastFloor()).toBe(true);
  });

  test("the watch ends a hold that has stood past the horizon, and the card's neighbour's stands", async () => {
    const { a, b } = await pages("a", "b");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    restoreGateStore._watchForTest(0);
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 1 });

    // `b` begins holding late; `a` never lets go.
    restoreGateStore._watchForTest(HOLD_HORIZON_MS - 2_000);
    cardRestoreHold.on(b.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);

    restoreGateStore._watchForTest(HOLD_HORIZON_MS);
    // `a` is past its horizon and counts as done; `b` holds on, in a round of its own.
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 1 });

    restoreGateStore._watchForTest(2 * HOLD_HORIZON_MS);
    expect(restoreGateStore.getSnapshot().open).toBe(false);

    // Still saying it, `a` does not take the gate back; a new hold after a break does.
    cardRestoreHold.on(b.bus).set(null);
    cardRestoreHold.on(a.bus).set(null);
    await bus.flush();
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);
  });
});

describe("one gate for each cold arrival", () => {
  /** Count the gate's opens and closes from here on. */
  function edges(): { opens: number; closes: number; release(): void } {
    const seen = { opens: 0, closes: 0, release: () => {} };
    let open = restoreGateStore.getSnapshot().open;
    seen.release = restoreGateStore.subscribe(() => {
      const now = restoreGateStore.getSnapshot().open;
      if (now === open) return;
      open = now;
      if (now) seen.opens += 1;
      else seen.closes += 1;
    });
    return seen;
  }

  test("a staged arrival opens once and closes once, at its last card's settle", async () => {
    const { a, b, c } = await pages("a", "b", "c");
    for (const id of ["a", "b", "c"]) bodyCardsStore.mark(id);
    const seen = edges();
    at(0);
    restoreGateRoster.expect(["a", "b", "c"]);
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 3 });

    // Pages are made two at a time: `a` and `b` restore and settle while
    // `c`'s page is still to be made.
    at(200);
    cardRestoreHold.on(a.bus).set("waiting");
    cardRestoreHold.on(b.bus).set("waiting");
    await bus.flush();
    at(400);
    cardRestoreHold.on(a.bus).set("holding");
    cardRestoreHold.on(b.bus).set("holding");
    await bus.flush();
    at(900);
    cardRestoreHold.on(a.bus).set(null);
    cardRestoreHold.on(b.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 2, sessionsTotal: 3 });

    // Past the floor with `c` still pageless: the gate does not drop.
    at(2_000);
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 2, sessionsTotal: 3 });
    cardRestoreHold.on(c.bus).set("holding");
    await bus.flush();
    at(3_000);
    cardRestoreHold.on(c.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    seen.release();
    expect(seen).toMatchObject({ opens: 1, closes: 1 });
  });

  test("a 300 ms arrival closes at the floor, reading every session finished until then", async () => {
    const { a } = await pages("a");
    bodyCardsStore.mark("a");
    const seen = edges();
    at(0);
    restoreGateRoster.expect(["a"]);
    at(100);
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    at(300);
    cardRestoreHold.on(a.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 1, sessionsTotal: 1 });
    at(GATE_FLOOR_MS - 1);
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 1, sessionsTotal: 1 });
    at(GATE_FLOOR_MS);
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    seen.release();
    expect(seen).toMatchObject({ opens: 1, closes: 1 });
  });

  test("a hold arriving inside the floor keeps the gate open, and it closes when that hold ends", async () => {
    const { a, b } = await pages("a", "b");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    const seen = edges();
    at(0);
    // The arrival is `a`'s, named by its pass; `b` resumes on its own inside the floor.
    restoreGateRoster.expect(["a"]);
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    at(300);
    cardRestoreHold.on(a.bus).set(null);
    await bus.flush();
    at(600);
    cardRestoreHold.on(b.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);
    at(2_000);
    expect(restoreGateStore.getSnapshot().open).toBe(true);
    cardRestoreHold.on(b.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    seen.release();
    expect(seen).toMatchObject({ opens: 1, closes: 1 });
  });

  test("a card resuming on its own, named by no pass, closes the gate at its settle: the floor is the arrival's", async () => {
    const { a } = await pages("a");
    bodyCardsStore.mark("a");
    const seen = edges();
    at(0);
    cardRestoreHold.on(a.bus).set("waiting");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 1 });
    at(100);
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    at(300);
    cardRestoreHold.on(a.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    seen.release();
    expect(seen).toMatchObject({ opens: 1, closes: 1 });
  });

  test("a pass naming cards while a lone resume holds the gate gives it the floor, counted from its open", async () => {
    const { a, b } = await pages("a", "b");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    at(0);
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    at(400);
    restoreGateRoster.expect(["b"]);
    cardRestoreHold.on(b.bus).set("holding");
    await bus.flush();
    at(600);
    cardRestoreHold.on(a.bus).set(null);
    cardRestoreHold.on(b.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(true);
    at(GATE_FLOOR_MS - 1);
    expect(restoreGateStore.getSnapshot().open).toBe(true);
    at(GATE_FLOOR_MS);
    expect(restoreGateStore.getSnapshot().open).toBe(false);
  });

  test("a named card in a workspace nobody is shown never opens the gate", async () => {
    let activeSpaceId = "front";
    registerStubShellDeck({
      spaceOf: (cardId: string) => (cardId === "b" ? "parked" : "front"),
      getSpacesSnapshot: () => ({ activeSpaceId }),
      subscribeSpaces: () => () => {},
    } as unknown as IDeckManagerStore);
    const { b } = await pages("b");
    bodyCardsStore.mark("b");
    const seen = edges();
    at(0);
    restoreGateRoster.expect(["b"]);
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    for (const report of ["waiting", "holding", null] as const) {
      at(clock + 500);
      cardRestoreHold.on(b.bus).set(report);
      await bus.flush();
      expect(restoreGateStore.getSnapshot().open).toBe(false);
    }
    seen.release();
    expect(seen).toMatchObject({ opens: 0, closes: 0 });
    activeSpaceId = "parked";
  });

  test("a named card whose page is never made holds to the horizon and no further", async () => {
    await pages("a");
    bodyCardsStore.mark("a");
    at(0);
    restoreGateRoster.expect(["a"]);
    expect(restoreGateStore.getSnapshot().open).toBe(true);
    at(HOLD_HORIZON_MS - 1);
    expect(restoreGateStore.getSnapshot().open).toBe(true);
    at(HOLD_HORIZON_MS);
    expect(restoreGateStore.getSnapshot().open).toBe(false);
  });

  test("a card named over a page that has already painted holds until its page has reported and stopped", async () => {
    const { a, b } = await pages("a", "b");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    // `b`'s page was made ahead and has painted; the pass resumes it over the bus.
    bodyCardsStore.setState("b", "painted");
    const seen = edges();
    restoreGateRoster.expect(["a", "b"]);
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 2 });

    at(200);
    cardRestoreHold.on(a.bus).set("holding");
    await bus.flush();
    at(500);
    cardRestoreHold.on(a.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 1, sessionsTotal: 2 });

    // `b` says its restore is to come only now, and the total has not moved.
    at(1_500);
    cardRestoreHold.on(b.bus).set("waiting");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 1, sessionsTotal: 2 });
    at(2_000);
    cardRestoreHold.on(b.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    seen.release();
    expect(seen).toMatchObject({ opens: 1, closes: 1 });
  });

  test("cards named over pages made ahead and still asleep are counted from the open", async () => {
    const { a, b, c } = await pages("a", "b", "c");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    bodyCardsStore.mark("c");
    // `a` and `b` were made ahead in a parked workspace: painted, and asleep
    // until the host shows them. `c`'s page is still being made.
    bodyCardsStore.setState("a", "painted");
    bodyCardsStore.setState("b", "painted");
    cardFacts.on(a.bus).set({ ...FACTS, dormant: true });
    cardFacts.on(b.bus).set({ ...FACTS, dormant: true });
    await bus.flush();
    restoreGateRoster.expect(["a", "b", "c"]);
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 3 });

    // Shown, `a` wakes and restores, and `c`'s page arrives and does too.
    at(100);
    cardFacts.on(a.bus).set(FACTS);
    cardRestoreHold.on(a.bus).set("holding");
    cardRestoreHold.on(c.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 3 });
    at(2_000);
    cardRestoreHold.on(a.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 1, sessionsTotal: 3 });

    // `b` wakes last, into the same round.
    cardFacts.on(b.bus).set(FACTS);
    cardRestoreHold.on(b.bus).set("holding");
    cardRestoreHold.on(c.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 2, sessionsTotal: 3 });
    cardRestoreHold.on(b.bus).set(null);
    await bus.flush();
    expect(restoreGateStore.getSnapshot().open).toBe(false);
  });

  test("a naming ends at the horizon: a card named over a painted page that never reports keeps no round pending", async () => {
    const { a, c } = await pages("a", "c");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("c");
    bodyCardsStore.setState("a", "painted");
    cardFacts.on(a.bus).set({ ...FACTS, dormant: true });
    await bus.flush();
    restoreGateRoster.expect(["a", "c"]);
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 2 });
    at(100);
    cardRestoreHold.on(c.bus).set("holding");
    await bus.flush();
    at(2_000);
    cardRestoreHold.on(c.bus).set(null);
    await bus.flush();
    // Nothing holds: `a` sleeps on, a member that has said nothing.
    expect(restoreGateStore.getSnapshot().open).toBe(false);

    // Past the horizon the next arrival's round is its own.
    at(HOLD_HORIZON_MS);
    cardRestoreHold.on(c.bus).set("holding");
    await bus.flush();
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 1 });
  });

  test("a named card whose page fails, or is never asked for, lets go", async () => {
    await pages("a", "b");
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b", "unmade");
    at(0);
    restoreGateRoster.expect(["a", "b"]);
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, sessionsDone: 0, sessionsTotal: 1 });
    bodyCardsStore.setState("a", "failed");
    expect(closedPastFloor()).toBe(true);
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

  test("a resumed card's content is not said painted until its transcript has settled", () => {
    // The walk of a cold restore, in order: named by the restore pass, bound
    // with the preflight still to open, preflight, replaying, revealing.
    expect(restorePaintQuiet(null, true)).toBe(false);
    expect(restorePaintQuiet(snapshot({}), false)).toBe(false);
    expect(restorePaintQuiet(snapshot({ replayPreflightActive: true }), false)).toBe(false);
    expect(restorePaintQuiet(snapshot({ phase: "replaying" }), false)).toBe(false);
    expect(restorePaintQuiet(snapshot({ replayEverCompleted: true }), false)).toBe(false);
    // The list's first settle, or the reveal's bound, ends it.
    expect(restorePaintQuiet(snapshot({ replayEverCompleted: true, coldRevealSettled: true }), false)).toBe(true);
  });

  test("an errored restore, a fresh session and a card with no session are painted at once", () => {
    expect(restorePaintQuiet(snapshot({ phase: "replaying", lastError: { cause: "replay_stalled" } as never }), false)).toBe(true);
    expect(restorePaintQuiet(snapshot({ replayEverCompleted: true, lastError: { cause: "resume_failed" } as never }), false)).toBe(true);
    expect(restorePaintQuiet(snapshot({ sessionMode: "new" }), false)).toBe(true);
    expect(restorePaintQuiet(null, false)).toBe(true);
  });
});
