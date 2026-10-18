/**
 * The restore gate holds for a body card's cold restore, which its body
 * reports.
 *
 * A body Session card's session store is in its own page, so the shell's
 * services store has none for it. Its body puts the card's restore in its
 * `card-facts` telemetry (`restoreHoldTelemetry`, `body-publisher.ts`) while
 * `deriveRestoreGateHold` holds it — the replay window and the reveal behind
 * it — and nothing once it lets go, including when the card's own silence
 * deadline errors it. The shell's gate folds those reports: open while any
 * body card says it is restoring, with its turns summed; closed when it
 * stops saying so, when its page is terminated (`endRestoreHold`), and for a
 * card that is not a body card.
 *
 * @covers tugdeck/src/lib/restore-gate-store.ts
 * @covers tugdeck/src/lib/body-facts-store.ts
 * @covers tugdeck/src/body/body-publisher.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CardFacts } from "@tugproto/bus";
import { restoreGateStore } from "../restore-gate-store";
import { bodyCardsStore } from "../body-cards-store";
import { bodyFactsStore } from "../body-facts-store";
import { restoreHoldTelemetry } from "../../body/body-publisher";
import type { CodeSessionSnapshot } from "../code-session-store";

function facts(telemetry: Record<string, number> = {}): CardFacts {
  return {
    title: "Session",
    masthead: null,
    activity: "idle",
    telemetry: { canInterrupt: 0, compacted: 0, ...telemetry },
  };
}

const HOLD = { restoreHold: 1, restoreTurnsLoaded: 3, restoreTurnsTarget: 10 };

afterEach(() => {
  bodyFactsStore._reset();
  bodyCardsStore._reset();
});

describe("the shell's gate over body cards", () => {
  test("opens for a body card its body says is restoring, and sums the turns", () => {
    bodyCardsStore.mark("a");
    bodyCardsStore.mark("b");
    expect(restoreGateStore.getSnapshot().open).toBe(false);

    bodyFactsStore.applyFacts("a", facts(HOLD));
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, cards: 1, turnsLoaded: 3, turnsTarget: 10 });

    bodyFactsStore.applyFacts("b", facts({ restoreHold: 1, restoreTurnsLoaded: 1, restoreTurnsTarget: 5 }));
    expect(restoreGateStore.getSnapshot()).toEqual({ open: true, cards: 2, turnsLoaded: 4, turnsTarget: 15 });

    bodyFactsStore.applyFacts("a", facts());
    bodyFactsStore.applyFacts("b", facts());
    expect(restoreGateStore.getSnapshot().open).toBe(false);
  });

  test("notifies its readers when a body's report moves it", () => {
    bodyCardsStore.mark("a");
    let notified = 0;
    const release = restoreGateStore.subscribe(() => {
      notified += 1;
    });
    bodyFactsStore.applyFacts("a", facts(HOLD));
    bodyFactsStore.applyFacts("a", facts());
    release();
    expect(notified).toBe(2);
  });

  test("the hold goes with the page: a termination ends it, the card's other facts stand", () => {
    bodyCardsStore.mark("a");
    bodyFactsStore.applyFacts("a", facts({ ...HOLD, canInterrupt: 1 }));
    expect(restoreGateStore.getSnapshot().open).toBe(true);

    bodyFactsStore.endRestoreHold("a");
    expect(restoreGateStore.getSnapshot().open).toBe(false);
    expect(bodyFactsStore.canInterrupt("a")).toBe(true);
  });

  test("a card that is no body card is not held, and a destroyed one lets go", () => {
    bodyFactsStore.applyFacts("stray", facts(HOLD));
    expect(restoreGateStore.getSnapshot().open).toBe(false);

    bodyCardsStore.mark("a");
    bodyFactsStore.applyFacts("a", facts(HOLD));
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
    expect(restoreHoldTelemetry(snapshot({ phase: "replaying" }))).toEqual({
      restoreHold: 1,
      restoreTurnsLoaded: 2,
      restoreTurnsTarget: 10,
    });
    expect(restoreHoldTelemetry(snapshot({ replayPreflightActive: true })).restoreHold).toBe(1);
    expect(restoreHoldTelemetry(snapshot({ replayEverCompleted: true })).restoreHold).toBe(1);
  });

  test("nothing outside a restore, after the reveal settles, or once the card errors (the silence deadline)", () => {
    expect(restoreHoldTelemetry(null)).toEqual({});
    expect(restoreHoldTelemetry(snapshot({}))).toEqual({});
    expect(restoreHoldTelemetry(snapshot({ replayEverCompleted: true, coldRevealSettled: true }))).toEqual({});
    expect(
      restoreHoldTelemetry(snapshot({ phase: "replaying", lastError: { cause: "replay_stalled" } as never })),
    ).toEqual({});
    expect(restoreHoldTelemetry(snapshot({ phase: "replaying", sessionMode: "new" }))).toEqual({});
  });
});
